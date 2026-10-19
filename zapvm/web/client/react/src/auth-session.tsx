import { useQuery, useQueryClient } from "@tanstack/react-query";
import { ArrowRight, Check, Cloud, KeyRound, LoaderCircle, LockKeyhole, TerminalSquare } from "lucide-react";
import { useCallback, useEffect, useRef, useState } from "react";
import type { FormEvent, ReactNode } from "react";
import { api, APIError, setCSRFToken } from "./api";
import { publishAuthSync, subscribeAuthSync } from "./auth-sync";
import { BrandLockup, BrandMark, Button } from "./design-system";
import { queryKeys } from "./query-keys";
import type { BrowserSession } from "./types";

interface AuthenticatedApplicationProps {
  session: BrowserSession;
  signOut: () => Promise<void>;
}

export function AuthSessionBoundary({ children }: { children: (props: AuthenticatedApplicationProps) => ReactNode }) {
  const queryClient = useQueryClient();
  const sessionQuery = useQuery({ queryKey: queryKeys.session, queryFn: api.session, retry: false, staleTime: 60_000 });
  const session = sessionQuery.data;

  const clearWorkspaceState = useCallback(() => {
    queryClient.removeQueries({ predicate: (query) => query.queryKey[0] !== queryKeys.session[0] && query.queryKey[0] !== queryKeys.authOptions[0] });
  }, [queryClient]);

  const acceptSession = useCallback((next: BrowserSession, announce = true) => {
    clearWorkspaceState();
    setCSRFToken(next.csrf_token);
    queryClient.setQueryData(queryKeys.session, next);
    if (announce) publishAuthSync("authenticated");
  }, [clearWorkspaceState, queryClient]);

  const acceptSignedOut = useCallback((announce = true) => {
    clearWorkspaceState();
    setCSRFToken();
    queryClient.setQueryData<BrowserSession>(queryKeys.session, { authenticated: false });
    if (announce) publishAuthSync("signed-out");
  }, [clearWorkspaceState, queryClient]);

  useEffect(() => setCSRFToken(session?.csrf_token), [session?.csrf_token]);

  useEffect(() => subscribeAuthSync((event) => {
    if (event.type === "signed-out") {
      acceptSignedOut(false);
      return;
    }
    void queryClient.invalidateQueries({ queryKey: queryKeys.session, exact: true });
  }), [acceptSignedOut, queryClient]);

  useEffect(() => {
    const refresh = () => {
      if (document.visibilityState === "visible") void queryClient.invalidateQueries({ queryKey: queryKeys.session, exact: true });
    };
    window.addEventListener("focus", refresh);
    document.addEventListener("visibilitychange", refresh);
    return () => {
      window.removeEventListener("focus", refresh);
      document.removeEventListener("visibilitychange", refresh);
    };
  }, [queryClient]);

  const signOut = useCallback(async () => {
    await api.logout().catch(() => undefined);
    acceptSignedOut();
  }, [acceptSignedOut]);

  if (sessionQuery.isPending && !session) return <WorkspaceSplash />;
  if (!session?.authenticated) return <LoginPage onAuthenticated={acceptSession} />;
  return <>{children({ session, signOut })}</>;
}

function WorkspaceSplash() {
  return <main className="splash" aria-label="正在加载 Workspace"><div className="splash-lockup"><BrandMark /><span><strong>zapVM</strong><small><LoaderCircle className="size-3 animate-spin" />正在进入 Workspace</small></span></div></main>;
}

function LoginPage({ onAuthenticated }: { onAuthenticated: (session: BrowserSession) => void }) {
  const authOptions = useQuery({ queryKey: queryKeys.authOptions, queryFn: api.authOptions, retry: false, staleTime: 60_000 });
  const [token, setToken] = useState("");
  const [error, setError] = useState("");
  const [pending, setPending] = useState(false);
  const inviteHandled = useRef(false);

  useEffect(() => {
    if (inviteHandled.current) return;
    const invite = new URLSearchParams(window.location.hash.slice(1)).get("invite");
    if (!invite) return;
    inviteHandled.current = true;
    window.history.replaceState(null, "", `${window.location.pathname}${window.location.search}`);
    setPending(true);
    void api.redeemInvite(invite).then(onAuthenticated).catch(() => {
      setError("邀请链接无效或已过期，请联系 Workspace 管理员重新发送。");
    }).finally(() => setPending(false));
  }, [onAuthenticated]);

  async function submit(event: FormEvent) {
    event.preventDefault();
    setError("");
    setPending(true);
    try {
      onAuthenticated(await api.login(token.trim()));
      setToken("");
    } catch (reason) {
      setError(authErrorMessage(reason));
    } finally {
      setPending(false);
    }
  }

  const oidc = authOptions.data?.oidc;
  return <main className="login-shell">
    <header className="login-header"><BrandLockup /><div className="login-system-state"><span />Control plane operational</div></header>
    <section className="login-layout">
      <div className="login-story">
        <div className="brand-kicker">AGENT COMPUTER PLATFORM</div>
        <h1>给 Agent 一台<br /><span>真正能工作的电脑</span></h1>
        <p>在隔离的远端环境中完成检索、编码、运行与交付。任务持续执行，结果随时回来查看。</p>
        <div className="login-capabilities" aria-label="平台能力">
          <div><TerminalSquare /><span><strong>完整执行环境</strong><small>Shell、文件、Git 与工具链</small></span></div>
          <div><Cloud /><span><strong>持续运行</strong><small>关闭浏览器也不会中断任务</small></span></div>
          <div><LockKeyhole /><span><strong>Workspace 隔离</strong><small>身份、项目和产物边界清晰</small></span></div>
        </div>
      </div>
      <section className="login-card login-card-auth" aria-label="登录 Workspace">
        <div className="login-card-heading"><div className="login-card-icon"><KeyRound /></div><div><span>WORKSPACE ACCESS</span><h2>登录 zapVM</h2></div></div>
        <p className="login-card-copy">进入团队 Workspace，继续你的 Agent 任务和交付记录。</p>
        {pending && <div className="login-progress"><LoaderCircle className="size-4 animate-spin" />正在验证登录信息…</div>}
        {!pending && oidc && <Button tone="primary" size="lg" fullWidth className="login-provider" onClick={() => window.location.assign(oidc.start_url)}>使用 {oidc.display_name} 登录<ArrowRight className="size-4" /></Button>}
        {!pending && !oidc && <section className="invite-login"><div className="invite-login-icon"><Check /></div><span><strong>使用邀请链接登录</strong><small>打开 Workspace 管理员发送的专属链接，系统会自动完成身份验证。</small></span></section>}
        {authOptions.isError && <p className="form-error" role="alert">登录服务暂时不可用，请稍后重试。</p>}
        {error && <p className="form-error" role="alert">{error}</p>}
        <div className="login-help">没有邀请链接？<span>请联系你的 Workspace 管理员</span></div>
        <details className="emergency-login"><summary>使用管理员访问密钥</summary><p>仅用于部署验收和应急恢复。密钥只参与本次登录，不会保存在浏览器。</p><form onSubmit={submit} className="grid gap-4"><label className="field-label">Workspace access token<input value={token} onChange={(event) => setToken(event.target.value)} autoComplete="off" required type="password" placeholder="输入访问密钥" /></label>
          <Button tone="secondary" fullWidth disabled={pending} leadingIcon={pending && <LoaderCircle className="size-4 animate-spin" />}>{pending ? "登录中" : "管理员登录"}</Button></form></details>
        <footer><LockKeyhole />连接由 HTTPS 与 HttpOnly Session 保护</footer>
      </section>
    </section>
    <footer className="login-footer"><span>zapVM Agent Computer</span><span>Secure remote execution · Persistent workspace · Artifact delivery</span></footer>
  </main>;
}

function authErrorMessage(reason: unknown) {
  if (reason instanceof APIError) return reason.message;
  if (reason instanceof Error) return reason.message;
  return "登录失败，请稍后重试。";
}

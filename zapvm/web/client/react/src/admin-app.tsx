import { ArrowLeft, LogOut, ShieldCheck } from "lucide-react";
import { useEffect } from "react";
import { AdminAccessDenied } from "./admin-computers";
import { AdminPlatform } from "./admin-platform";
import { BrandLockup, Button } from "./design-system";
import type { BrowserSession } from "./types";

export function AdminApplication({ session, onBack, onSignOut }: {
  session: BrowserSession;
  onBack: () => void;
  onSignOut: () => Promise<void>;
}) {
  const canManagePlatform = session.role === "owner" || session.role === "admin";
  const identity = session.display_name ?? session.user_display_name ?? session.user_id ?? "Workspace Admin";

  useEffect(() => { document.title = "Workspace 管理 · zapVM"; }, []);

  return <div className="admin-shell">
    <header className="admin-shell-header" aria-label="Workspace 管理导航">
      <a className="admin-shell-brand" href="/new" onClick={(event) => {
        if (event.button || event.metaKey || event.ctrlKey || event.shiftKey || event.altKey) return;
        event.preventDefault();
        onBack();
      }}><BrandLockup /></a>
      <div className="admin-shell-context">
        <span><ShieldCheck />ADMIN CONSOLE</span>
        <strong>{identity}</strong>
        <small>{session.role ?? "member"} · {session.project_id ?? "Workspace"}</small>
      </div>
      <div className="admin-shell-actions">
        <Button aria-label="返回 Agent 工作区" tone="secondary" leadingIcon={<ArrowLeft />} onClick={onBack}>返回 Agent 工作区</Button>
        <Button aria-label="退出登录" tone="quiet" leadingIcon={<LogOut />} onClick={() => void onSignOut()}>退出登录</Button>
      </div>
    </header>
    <main className="admin-shell-main">
      {canManagePlatform ? <AdminPlatform /> : <AdminAccessDenied onBack={onBack} />}
    </main>
  </div>;
}

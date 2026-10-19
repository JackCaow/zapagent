# Git Provider 安全边界

zapVM 的 Git Provider 用于让远端 Agent 把工作区变更安全地提交到指定仓库，而不是把 GitHub 凭据交给 Guest 或 Agent Bash。

## 当前已交付

- Control 从 owner-only 配置读取 GitHub App provision，并从 owner-only PEM 文件加载 RSA-2048 或更强私钥。
- provision 固定绑定 tenant、project、GitHub App installation、owner、repository 和默认 base branch。
- `GET /v1/agent/git/providers` 只返回当前 mTLS Client 身份可见的非秘密仓库描述。
- Control 签发 9 分钟 GitHub App JWT，并通过 GitHub installation access-token API 申请短期 token。
- token 请求被收窄到单个 repository，以及 `contents:write`、`pull_requests:write`、`metadata:read`；HTTP redirect 被拒绝。
- token 只存在于进程内 `Capability`，不参与 JSON 序列化；使用者必须在完成或失败后调用 `Destroy` 清零其字节。
- GitHub 响应体限制为 64 KiB，token 长度不假定为固定 40 字符，有效期只接受 1 分钟到 2 小时。
- Browser 可为一个已成功 Agent Task 显式创建幂等 Git operation；Task、tenant、project、Computer 和 provider 必须一致。
- Control 只生成 `zapvm/<operation_id>`，不接受调用方选择 branch、remote、commit argv 或直接写默认/保护分支。
- Node 通过当前 mTLS lease 领取短期 capability，只转交 owner-only Host daemon，不注入 Guest 或 Agent Bash。
- Host Git writer 要求真实 `.git` 目录且拒绝其中的 symlink，拒绝 filter、URL rewrite、credential、include、HTTP 和危险 core 本地配置。
- Host 固定禁用 hooks、credential helper、GPG signing、file/ext protocol、redirect 和交互提示；token 只进入 Git 网络子进程的 `http.extraHeader` 环境，不进入 argv。
- commit 排除任何层级的 `.git/.zapcode`，要求无预暂存内容、当前 HEAD 等于远端默认分支，并写入 `ZapVM-Operation` trailer。
- 重试只在同一 operation branch/trailer/commit 下复用；远端同名分支指向其他 commit 时 fail closed，不 force push。
- Host push 成功后，Control 使用新的短期 installation token 查询同 owner/base/head 的 PR；已有 PR 必须匹配 commit，否则 fail closed。
- 找不到 PR 时 Control 以固定 title/body/head/base 创建；`422` 竞态会重新查询，重试不会重复创建 PR。
- Node 不能上报 PR number/URL/state；Control 校验 GitHub 返回的 head SHA、base、精确 Web URL 后才写入终态，Web 只显示该脱敏结果。
- GitHub 网络、429 或 5xx 不消耗当前 Node lease，允许同一 operation 重试；权限、分支和响应冲突进入稳定失败终态。
- Web 只对 succeeded Task 启用“创建 PR”，并由 Project、Task、Computer、Provider 确定性生成 operation ID；刷新或不确定提交不会产生新分支。
- submit、lease、complete、expire、fence、delete/prune 均写入 hash-chain audit，并绑定源 Task 与 operation。

授权、受控 branch/commit/push、GitHub PR create/reconcile、状态回传和 Web 操作入口均已完成组件级交付。真实 GitHub App、远端仓库和 VM 黑盒闭环归 `E2E-02`。

## 配置

在 `cloud-control.json` 中增加：

```json
{
  "github_apps": [
    {
      "id": "github",
      "tenant_id": "acme",
      "project_id": "default",
      "app_id": 123456,
      "installation_id": 789012,
      "private_key_file": "/run/zapvm-control/github-app-private-key.pem",
      "owner": "example-org",
      "repository": "example-repo",
      "default_base_branch": "main"
    }
  ]
}
```

`tenant_id/project_id` 必须已存在于至少一个 Node scope。GitHub.com 默认使用 `https://api.github.com` 和 `https://github.com`；GitHub Enterprise Server 可通过 `api_base_url` 与 `web_base_url` 显式声明 HTTPS origin。

私钥必须是绝对路径、单个 PKCS#1/PKCS#8 RSA PEM，并且文件仅 owner 可读。在 Railway 的单 GitHub App Beta 配置中：

```bash
base64 < /secure/path/github-app-private-key.pem | tr -d '\n' | railway variable set ZAPVM_GITHUB_APP_PRIVATE_KEY_B64 --stdin --skip-deploys
```

entrypoint 会写入 `/run/zapvm-control/github-app-private-key.pem`、设置 `0600` 并在启动前移除环境变量。多 App provision 应使用独立 secret mount/secret manager，而不是复用这一单文件变量。

## 不变量

1. Browser 只能看到 repository descriptor，不接触任何 token。
2. Guest、Agent prompt、Bash 环境、Task/Event、Artifact 和日志不得出现 JWT、installation token 或私钥。
3. Node 只能凭当前 lease 领取与 Task、provider、操作类型绑定的一次性能力。
4. Git write 必须在 Host 侧使用固定 argv、禁用 hooks、校验 remote/branch/worktree，不能执行 Guest 提供的任意 Git 命令。
5. commit/push/PR 必须幂等并写入审计；只有 PR 已创建或严格复用后 operation 才能成功，失败不得把仅 push 的变更误报为已交付。

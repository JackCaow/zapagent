# Zap 交互权限模式调研

调研日期 2026-11-28。基线为 [Zap v1.14.39](https://github.com/JackCaow/zapagent/releases/tag/v1.14.39)。竞品部分依据官方文档，Zap 行为取自已安装版本及原生 CLI 的隔离 tmux 实测。

[产品需求](65-permission-mode-prd.md) · [实施与验收](66-permission-mode-tasks.md)

## 五款工具的做法

| 产品 | 审批与实际访问范围 | 对 Zap 的参考 |
| --- | --- | --- |
| Codex CLI | 可单独选择是否询问、由谁复审，以及文件与网络边界。关闭审批时仍可保留工作区限制。 | 审批和执行范围分别验证。 [官方文档](https://learn.chatgpt.com/docs/agent-approvals-security#run-without-approval-prompts) |
| Claude Code | Manual 询问多数修改和命令，Auto 有后台分类器，Bypass 跳过多数提示并有显式例外。任意子进程的访问约束依靠执行边界。 | 借鉴审批卡和统一入口。原生模式名称不足以证明权限相同。 [权限文档](https://code.claude.com/docs/en/permissions) |
| Gemini CLI | YOLO 自动批准工具调用，文档仍描述默认启用沙箱。 | 免逐次审批与有界执行可以同时成立。 [配置与沙箱](https://geminicli.com/docs/reference/configuration/#sandboxing) |
| GitHub Copilot CLI | 可分别指定工具、路径和 URL 的许可。显式拒绝优先于 Allow All。Autopilot 决定任务是否继续。 | 自治、授权和审批有独立含义，界面可以保持简单。 [工具权限](https://docs.github.com/en/copilot/how-tos/copilot-cli/use-copilot-cli/allowing-tools) · [Autopilot](https://docs.github.com/en/copilot/how-tos/copilot-cli/use-copilot-cli/use-autopilot-mode) |
| OpenCode V2 | Allow、Ask、Deny 按动作和资源配置，可保存项目审批。Shell 扫描尽力推断目录，并明确说明该限制。 | 命令文本可描述批准对象。脚本的实际读写和网络范围需要执行端验证。 [权限与扫描](https://opencode.ai/docs/permissions/) |

对照提供设计取舍。Gemini、Copilot 和 OpenCode 的行为来自文档。同名模式在不同产品中有不同的授权含义。

## Zap 现场证据

| 编号 | 场景 | 结果 |
| --- | --- | --- |
| E1 | Zap Bypass，用户要求打开工作区页面 | 复合 Shell 命令仍弹单次审批。只读 SVG 循环也出现相同体验。 |
| E2 | Zap Auto，间接 Shell 发布 | 拒绝后回环接收端收到 0 次写入，批准后收到 1 次。 |
| E3 | Claude Code，Auto 和 Manual 发布 | 两档均转发审批。每档拒绝 0 次写入，批准 1 次。 |
| E4 | Codex，Auto 和 Manual 发布 | Auto 下回环连接失败，Zap 未显示审批；Manual 下表示将请求审批，75 秒仍无 Zap 审批，随后中断。两次均无写入。 |
| E5 | 普通回复和失败工具结果 | Codex、Claude 的普通回复无固定验收提示。Zap 原生失败 Shell 执行一次，真实错误可见。 |
| E6 | Codex Manual 下只写临时项目文件，观察两段协议 | Zap 收到 read-only 模式切换回执。原生服务以 on-request 开始回合，并启动本机的 PermissionRequest hook。75 秒内未收到 ACP 审批，临时文件未写入。 |

E1 来自用户截图。E2–E5 来自已安装版本的实测，两段原生录屏已在会话中交付。写入使用本机回环服务与合成数据。

## 对当前实现的结论

1. 本地交互执行器关闭进程隔离。现行裁决在 Bypass 放行前要求未批准的 Shell 单独授权。该保护拦得住一次脚本调用，也会拦住日常预览。精确命令规则描述批准的调用，其本身无法约束脚本内容。 [执行入口](../../src/hooks/useAgentObjects.ts) · [审批策略](../../src/permission-policy.ts)
2. Auto 要做到项目内构建直接执行、外部写入按目标授权，需有实际约束或可验证的结构化动作。适配器应复用已有执行和授权能力。 [工作区授权](../../src/workspace-access.ts) · [工具授权设计](57-tool-authorization.md)
3. Codex 的等待原因仍须核对协议往返。记录原生设置、ACP 请求、Zap 选择、回传及执行结果。Claude 有已通过的正反例，可用于比较。 [ACP 接线](../../zapsdk/acp-client/connection.ts) · [Claude 接线](../../src/agent/claude-code.ts)

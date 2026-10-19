# Agent Harness

## 目标

`zapsdk/testing` 提供一个可复现、可注入、可观测的 agent 场景运行器。它用于验证
`LoopAgent` 的真实运行协议，而不是另外实现一套测试专用状态机。

Harness 解决此前测试能力分散的问题：测试文件不再各自维护 provider 调用计数器、
手工拼接 stream chunk、事件监听器和超时兜底；相同场景也可以切换 call/stream 两条
传输路径运行。

它不是在线模型评测框架，也不负责 TUI snapshot。真实 provider 的质量评估继续放在
eval；TUI 渲染测试继续放在 `tests/ui`。Harness 的边界是 SDK agent runtime。

## 架构

```text
ScriptedTurn[]
      │
      ▼
ScriptedProvider ── captured requests
      │
      ▼
LoopAgent ── AgentEvent[] ── tool trace
      │
      ▼
ToolExecutor + caller ToolRegistry
```

- `ScriptedProvider` 实现正式的 `LLMProvider` 接口。
- `AgentHarness` 创建正式的 `ToolExecutor` 和 `LoopAgent`。
- caller 可以注入工具表、审批回调、policy、agent budget 等正式选项。
- 每次 `run()` 只返回本次新增的 provider request 和 event，支持一个 harness 做多 turn
  会话测试。
- 工具轨迹以 `path + toolCallId` 配对，兼容 root/subagent 事件。

## 脚本模型

一个 `ScriptedTurn` 可以是：

1. 完整 `LLMResponse`；
2. 原始 `LLMChunk[]`，用于精确构造流式边界；
3. 接收当前 request snapshot 的函数；
4. 一个显式 error。

当 transport 为 `stream` 时，完整 response 会自动转换成合法 chunk 序列。需要验证
partial JSON、thinking delta 或流中断时再传原始 chunks。transport 为 `call` 时不会向
`LoopAgent` 暴露 `stream` 方法，确保 non-streaming 分支被真实覆盖。

脚本数量是协议断言的一部分：请求超过脚本会立即报出 request 序号；场景结束后默认
要求全部 turn 被消费，避免 agent 少跑一步但测试仍然通过。

## 使用示例

```ts
import { z } from "zod";
import { ToolRegistry } from "zapagent";
import {
  runAgentScenario,
  scriptedTextResponse,
  scriptedToolCallResponse,
} from "zapagent/testing";

const registry = new ToolRegistry();
registry.register({
  definition: {
    name: "lookup",
    description: "Look up a value",
    parameters: z.object({ key: z.string() }),
    readOnly: true,
  },
  handler: async ({ key }) => ({ success: true, output: String(key) }),
});

const run = await runAgentScenario({
  input: "lookup alpha",
  registry,
  turns: [
    scriptedToolCallResponse([
      { id: "call-1", name: "lookup", arguments: { key: "alpha" } },
    ]),
    scriptedTextResponse("done"),
  ],
});

expect(run.toolTrace[0]?.result?.output).toBe("alpha");
```

## 可靠性约束

- 默认单次 run 的外层硬超时是 5 秒，可通过 `runTimeoutMs` 调整。它与
  `LoopAgentOptions.timeoutMs` 不同：前者防测试挂死，后者验证 agent 自身的温和收尾。
- request、event、response 和结果在边界处复制，后续 run 不会篡改先前断言的数据。
- Harness 默认沿用 `ToolExecutor` 的 fail-closed 权限语义；需要写入或 confirm 工具时，
  测试必须显式传 `executorOptions.onApproval` 或 policy。
- Harness 不访问真实用户配置或 session。涉及持久化的上层测试仍须设置隔离的
  `ZAPCODE_DATA_DIR`。

## 后续演进

- 为 WorkspaceManager/MergeCoordinator 增加多 agent 隔离与合并场景 fixture。
- 为 checkpoint/rewind 提供临时 git workspace fixture。
- 基于 event/request 数据增加稳定的 trace formatter，便于 CI 输出最小失败差异。
- 将现有 LoopAgent 测试中的重复 mock provider 逐步迁移，不做一次性大规模重写。

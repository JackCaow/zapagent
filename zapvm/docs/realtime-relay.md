# Realtime Relay 与端到端加密

## 交付边界

Realtime Relay 解决传输延迟，E2EE 解决中继可见性；两者不是同一件事。当前版本已经接通 Node → Control 的 task-scoped mTLS WebSocket、事件批量 ACK、断线幂等重放、PostgreSQL 单事务批量写入，以及 Browser 的 animation-frame 合并渲染。

`internal/relaycrypto` 已实现 Browser ↔ Guest 会话所需的 P-256 ECDH、HKDF-SHA256、AES-256-GCM、方向密钥隔离、tenant/project/session/task/key epoch 绑定和严格序列防重放。它是协议与测试基础，尚未在产品 UI 中启用：在 Browser 公钥经过已认证会话送达 Guest、Guest 证明绑定到当前受信镜像、双方完成 key epoch 握手之前，产品不得显示“端到端加密”，Control 仍能读取现有 Task payload 与 event。

## 数据路径

```text
Browser --HTTPS/SSE--> Control --mTLS WebSocket--> Node --protected IPC--> Guest
                         ^ opaque only after E2EE activation ^
```

Realtime 路径的边界：

- Node 每个 active Task 建立一条出站 WebSocket，不要求云平台提供 `/dev/kvm`，也不要求向公网暴露本地主机端口。
- Guest event 在 25ms、64 条或 64 KiB 中最先命中的边界 flush。
- Control 只有在完整 batch 持久化后 ACK；Node 在 ACK 丢失时用相同 batch ID 和 source cursor 重放。
- PostgreSQL 后端在一个事务内提交完整 batch；文件后端继续依赖逐事件幂等语义。
- Browser 保留原 SSE 恢复游标，但把同一渲染帧内的 assistant delta 合并为一次 DOM 更新。

## E2EE 激活门槛

后续接线必须同时满足以下条件，不能降级为静默明文：

1. Browser 为每个 Project Session 生成临时 P-256 密钥，只把私钥保存在当前浏览器会话内。
2. Guest 在受保护 IPC 内生成临时密钥；返回的公钥必须绑定 Computer、受信镜像 digest、Session、Task 和 key epoch。
3. Control/Node 只转发公钥和 `relaycrypto.Envelope`，不持有会话对称密钥。
4. Prompt、assistant delta、工具输入输出和敏感 artifact manifest 全部使用 envelope；路由所需最小 metadata 保持明文并纳入 AAD。
5. 序列必须从 1 严格递增。断线恢复通过已确认序列续传，key epoch 变化时必须重新握手，禁止 nonce 重用。
6. 任一端不支持或证明失败时，E2EE-required Session 失败关闭；UI 明确区分“mTLS 传输保护”和“Browser ↔ Guest 端到端加密”。

## 运行模式

- `relay_mode=required`：生产模式。WebSocket 建立或 ACK 失败后任务失败，不回退逐事件 HTTPS。
- `relay_mode=auto`：滚动升级模式。Relay 连续失败后回退旧 HTTPS；不能用于低延迟或 E2EE 验收。
- `relay_mode=off`：兼容诊断模式。

本阶段没有消除 Node 的任务 admission polling；它只影响新任务开始时间，不再影响运行中 token/event 的传输速度。将 claim/heartbeat 复用到 node-level multiplexed socket 是下一阶段优化，不应和本次 task event Relay 混为一项验收。

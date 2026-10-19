# 图片 token 估算与模型规则

更新：2026-10-18。

## 计量边界

图片经 `image_url` / `image.source.base64` 发送。Base64 是 HTTP 传输字节，不是普通文本 token。上下文预算按模型视觉规则估算；请求体限制继续使用字节测量和历史图片淘汰的独立路径。API usage 仍是实际用量依据，本地公式不是服务端计费凭据。

`zapsdk/context/image-tokens.ts` 集中管理模型规则。`estimateImageTokens` 返回 tokens、rule、basis，basis 分为 model-rule、model-upper-bound、heuristic、not-sent。TokenCounter 累加视觉估算，文本估算保持现有启发式；本次没有改变语义压缩阈值、图片数据、图片淘汰水位或 provider usage。

## 规则来源与范围

以下来源于 2026-10-18 的官方文档/计算器；提供商以后可能调整同名模型的规则，应以新的官方示例更新注册表与回归向量。

- [DeepSeek Vision](https://api-docs.deepseek.com/guides/vision/) 和 [官方图片计算器](https://api-docs.deepseek.com/quick_start/token_usage/)：支持 deepseek-flash 与其旧 vision-exp 别名。复现公开计算器当前 v4.1 路径的 14px patch、3 倍下采样、行分隔及 framing、最小面积和最大 token 数。横竖图按原方向计算，不能排序宽高。不能用像素面积线性比例代替该算法。计算器公开脚本为 `assets/js/1e0da2c4.24c3fb4b.js`；开发时对照 1,000 组确定性尺寸，全部一致。
- [Claude Vision](https://platform.claude.com/docs/en/build-with-claude/vision) / [缩放规则](https://platform.claude.com/docs/en/build-with-claude/vision-coordinates)：按 28px patch、长边和 token 双约束搜索可容纳的最大等比尺寸，区分标准与 4.7 及以后高分辨率档位。日期后缀不作为模型小版本。
- [OpenAI Vision](https://developers.openai.com/api/docs/guides/images-vision)：注册表区分 tile 与 patch 模型，使用各自基数、乘数、像素限制、patch 预算及 detail。覆盖表中 GPT-4o/4.1、GPT-5/5.1/5.2/5.4/5.5/5.6 与 GPT-6-astra 等明确列出的型号。不能将小型模型、未知后缀或兼容 API 协议直接当作 GPT-4o。不会把 original 模式的服务端拒绝上限假设成自动缩放。

未注册型号（包括未核实的已弃用型号）走显式 heuristic：有尺寸时按 28px 分块、限制估算范围为 1,024–32,768；无尺寸时 4,096。这是可预测的回退预算，不是通用模型公式或保证上界。已知模型但无法解析尺寸时使用该规则的最大预算。通过 SDK provider options 的 `imageTokenRule` 可以指定私有别名的规则；单次切换到不同型号不会继承原型号的自定义规则。

## 数据与运行时接入

- `image-dimensions.ts` 从发送中的 Base64 头部最多解码约 64 KiB，支持 PNG、JPEG（含 progressive）、GIF、WebP（VP8/VP8L/VP8X）。不解码像素，不访问 `filePath`、URL，不改变 block。WeakMap 缓存按 block + Base64 内容失效；损坏/超长头部使用回退，避免预算计算抛异常。
- `ImageContent.detail` 可选，默认 auto。OpenAI-compatible 的用户图片和工具返回图片统一透传；Anthropic 不传此字段且使用自身规则。
- provider 暴露 `getImageTokenContext`；RetryProvider 转发，withModelOverride 使用子 agent 实际型号。LoopAgent 的请求预算、会话估计、缓存诊断和恢复前后计数共用模型信息。
- CLI 启动、模型切换及每轮 pre-turn compaction 前重算已有会话。重算本身不删消息、不改缓存前缀。运行时关闭 vision 后不再为未发送图片累计视觉 token。
- 会话和 SDK 调用者可传入 TokenCounter；自定义 provider 没有预算元数据时使用回退，保留旧接口兼容性。

## 验证

`zapsdk/tests/context/image-tokens.test.ts` 使用官方独立样例与模拟 provider 验证：DeepSeek 方向性与缩放、Claude 两档上限、OpenAI 不同 detail 与模型乘数、日期及命名空间、未知/损坏数据回退、四类文件头、Base64 体积与视觉 token 独立、wrapper/子模型覆盖、已有会话重算、LoopAgent 输出预算、恢复计数、wire detail 与图片字节保持不变。

验证命令：

```sh
bun test zapsdk/tests/context/image-tokens.test.ts zapsdk/tests/context/sidecar-budget.test.ts zapsdk/tests/agent/loop.budget-planner.test.ts
bun run typecheck
ZAPCODE_DATA_DIR=$(mktemp -d /tmp/zap-image-token-tests.XXXXXX) bun test
bun run build
```

本次验证不向外部模型发送私有 session。公式/模拟 provider 验证不等于服务端实际计费验证。

### 原 session 的离线复算

对此前 413 前读取的 30 张 PNG 按现存文件复算：Base64 共 51,878,704 字节（49.48 MiB），旧固定规则合计 22,950 tokens；新 DeepSeek 规则每张 968 tokens，合计 29,040 tokens（约为本地配置 1M 窗口的 2.9%，仅图片）。所有图片均成功解析尺寸，未走回退。此为本地规则估算，不是重发 API 后的服务端 usage。仅在临时目录保留聚合验证输出，未将路径、图片或会话内容提交到仓库。

### 最终验证结果

- 针对性回归：68 pass，0 fail。
- 固定最终代码的全量测试：4,378 pass，17 skip，0 fail（368 个文件）。使用独立 ZAPCODE_DATA_DIR；本地端口与 macOS Seatbelt 集成测试在宿主环境执行。
- `bun run typecheck`、`bun run typecheck:npm`、`bun run build`、`git diff --check` 通过。
- DeepSeek 官方计算器 1,000 组尺寸对照一致；原 session 的 30 张图片离线复算成功。

## models.dev 规范模型身份适配

`api.json` 的可选 `canonical_model_id` 经目录适配器转成 `canonicalModelId`，存入当前连接的 `modelMetadata[endpointModelId]`。字段在目录与配置读取边界校验为有界的 `lab/model` ID；它不改变模型列表、凭据、请求模型名或用户选择，也不触发额外目录网络请求。已有目录快照和配置持久化负责离线使用。

图片规则优先级：显式 `imageTokenRule` → 有效 canonical identity → 没有 identity 时的 endpoint model ID → 未知规则回退。有效但未知的规范型号不会继续借用渠道别名看起来相似的规则；规范 ID 的 lab 也必须与规则所属厂商一致。models.dev 只提供身份和能力，不能替代厂商图像公式。

Provider 接收按 endpoint ID 索引的 `canonicalModelIds` 映射。RetryProvider、子 agent 的单次模型覆盖、OpenAI 额外请求参数中的实际型号各自选取对应映射，不继承主模型的 identity。Anthropic 和 OpenAI-compatible 均只在本地预算中使用它。SDK 自定义 provider 也可在 `getImageTokenContext` 返回规范 ID。

同一别名经目录刷新改变身份时，CLI 的估算作用域会变化，已有会话重算并清除旧的用量校准样本；刷新响应移除/给出无效 identity，或完整 provider 快照中整个模型条目消失时，移除旧目录映射。目录中的其他未知能力字段沿用原合并策略；manual/provider 来源的显式元数据优先；刷新期间用户修改连接时不覆盖该修改。离线/请求失败不会凭空清除原配置。

当前目录把 DeepSeek 的 `deepseek-flash` 对应到 `deepseek/deepseek-v4.1-flash-1017`，该规范型号已关联此前核实的官方图片规则。这里记录精确已核实型号，不把所有未来 DeepSeek 版本自动套入同一算法。

新增验证入口：`tests/canonical-model-identity.test.ts`，覆盖目录解析、非法数据、配置回读、旧映射替换/移除、并发编辑保护、规范身份优先、未知型号、模型切换、两种协议工厂和请求内容的保持性。

来源：[models.dev 身份说明](https://github.com/anomalyco/models.dev#adding-model-metadata)、[schema](https://github.com/anomalyco/models.dev/blob/dev/packages/core/src/schema.ts)。

### 适配验证结果（2026-10-18）

- 目录、配置、图片规则针对性回归：76 pass，0 fail。
- 固定适配代码的全量测试：4,389 pass，17 skip，0 fail（369 个文件，116.64 秒）；使用独立 ZAPCODE_DATA_DIR，在宿主环境运行。
- `bun run typecheck`、`bun run typecheck:npm`、`bun run build`、`git diff --check` 通过。
- 当前公开目录快照离线验证：`deepseek-flash` → `deepseek/deepseek-v4.1-flash-1017`，1920×1080 图片为 968 tokens，basis 为 model-rule。未向模型接口发送私有会话或图片。

## 独立审查修正（2026-10-18）

三个独立 reviewer 分别检查公式与图片尺寸解析、运行时计量、目录元数据生命周期，修复四项 P2：

- 规则表只查询自有属性，避免未知型号 `constructor` / `__proto__` 命中对象原型并产生 NaN。
- Claude 缩放按官方 TypeScript 参考实现使用半数取偶和保持原运算顺序的宽高比除法；例如 2185×2186 标准档从错误的 1521 修正为 1560 tokens。新增四组边界及转置回归，另与官方 Python 算法生成的 2,000 组双档位预期值对照一致。
- 补齐直接使用 LoopAgent、不提供 ConversationManager 时的既有计量遗漏：自动压缩触发水位与压缩后增长基线统一采用模型感知计数器。新增连续读取 14 张图片的完整运行测试，分别覆盖有/无 ConversationManager，验证按 token 水位压缩一次后继续完成。
- 完整目录快照删除整个模型条目时清除其旧 canonical 映射；保留其他能力数据、手工映射和离线恢复行为。

官方取整来源：[Claude 图片缩放坐标参考](https://platform.claude.com/docs/en/build-with-claude/vision-coordinates)。本次不依据未证实的服务端 EXIF 方向处理假设改变 DeepSeek 公式。

修复后全量验证：4,398 pass，17 skip，0 fail（370 个文件，120.77 秒）。新增运行时测试的可选事件字段类型断言随后补齐，该测试重跑 2 pass；断言不改变运行时代码。`bun run typecheck`、`bun run typecheck:npm`、`bun run build`、`git diff --check` 均通过。没有重发私有 session 或图片到外部模型。

# Pi-Fusion 架构说明

## 核心机制

Pi-Fusion 通过 `pi.registerVirtualModel` 注册虚拟模型（默认 `router/fusion`）。Pi 在每次请求前调用 `route(request, ctx)`，路由器返回目标物理模型与 `thinkingLevel`，并把路由状态（`FusionRouteState`）交给 Pi 持久化到会话分支的 `pi.virtual-model-state` 条目中。

状态返回约定（与 Pi 语义一致）：

- 返回 `undefined` 或原 `request.state` 引用：保持当前状态，不追加会话条目。
- 返回新对象：Pi 无条件写入新条目。因此只有状态实际变化时才构造新对象。
- `direct` 请求没有状态，返回的状态会被 Pi 忽略。

## 模块职责

| 模块 | 职责 |
|---|---|
| `src/types.ts` | 配置、补丁、路由状态、健康快照与决策输入输出类型 |
| `src/constants.ts` | 默认配置、家族启发式画像、故障识别正则、分类器优先级与别名、各类上限 |
| `src/config.ts` | 默认 / 全局 / 项目三层合并、校验、旧版三档配置迁移、按层写入 |
| `src/health.ts` | 故障分类、冷却表、`1500ms` 防抖去重与指数退避 |
| `src/catalog.ts` | 候选池解析（显式配置或自动发现）、健康过滤、上下文容量守卫、大池预收敛 |
| `src/effort.ts` | 按 `thinkingMode`、画像 `effortMap` 与模型能力解析并 Clamp 思考强度 |
| `src/classifier.ts` | 分类器链解析、自定义端点注册、紧凑摘要构造、响应校验、超时与备用链 |
| `src/policy.ts` | 轮次步数与连续工具错误统计、Thinking 签名保护、周期复查、切换收益门控 |
| `src/router.ts` | `direct` / `retry` / `continuation` / `user` 四分支路由状态机 |
| `src/ui.ts` | 状态栏、切换通知、`SettingsList` 设置面板 |
| `src/commands.ts` | `/fusion` 与 `/router` 子命令、候选模型管理菜单、分类器选择 |
| `src/index.ts` | 扩展入口：加载配置、注册虚拟模型与自定义分类器端点、绑定事件与命令 |

## 配置系统

### 加载

`loadFusionRouterConfig` 按 默认配置 < 全局 `~/.pi/agent/fusion-router.json` < 项目 `<cwd>/.pi/fusion-router.json` 的顺序合并，`PI_CODING_AGENT_DIR` 可覆盖全局目录。每层先经过 `migrateLegacyConfig` 转换旧版格式，再由 `mergeAndValidateConfig` 逐字段校验，非法值保留下层结果并记录告警。

合并规则：

- 对象字段逐键合并，标量与普通数组整体替换。
- `models` 按 `provider/id` 合并：已存在的模型只覆盖该层显式写出的字段（例如项目层只写 `enabled: false` 时保留全局画像），新模型追加。
- `classifier.customEndpoint` 为 `null` 时清除下层的自定义端点；`defaultModel` 为空字符串时清除默认模型；候选模型的 `defaultThinking` 为 `null` 时清除该字段。

### 写入

所有命令与面板通过 `saveConfigPatchToLayer(patch, { scope })` 写入：

1. 读取目标层文件原始 JSON（旧版格式先转换；JSON 损坏时抛出错误并保留原文件）。
2. 将补丁按上述规则合并到该层原始对象，只写入变更字段。
3. 原子写入（临时文件 + `rename`）。
4. `index.ts` 重新执行完整的三层加载并重新注册虚拟模型。

默认写入范围：存在项目配置时写项目层，否则写全局层。候选池处于自动发现状态时修改单个模型，会先把当前发现结果写入配置，保证候选池其余部分不变。

## 候选池

`buildCandidatePool` 每次路由时构建：

1. `config.models` 非空时使用其中 `enabled` 的模型，否则从 `getAvailable()` 自动发现（排除 `pi-virtual`，超过 12 个时按成本档位轮转选取）。
2. 仅保留已认证的物理模型，并用家族启发式补全空的 `specialty` 与上下文参数。
3. 过滤冷却中的模型；全部冷却时保留全量兜底。
4. 按已用 Token 过滤上下文窗口不足的模型；全部不足时保留健康列表交给 Pi 原生 Compaction。
5. 预收敛为最多 12 个决策候选（保留当前模型）。

## 路由状态机

### 停用

`enabled: false` 时派发默认 / 回退模型，思考强度透传，不调用分类器，不返回状态。

### `direct`

用于 Compaction 摘要等 Agent 循环外调用。跳过分类器，优先当前模型或轻量健康模型，思考强度限制在 `off` / `low`，不返回状态。

### `retry`

Pi 仅在可重试的上游错误（`isRetryableAssistantError`）或上下文溢出 Compaction 之后发起 `retry`。路由器：

1. 用 `request.failed.message` 的 `stopReason` / `errorMessage` 更新健康表。
2. 上下文溢出时保持原模型。
3. 开启 `autoFailover` 时从健康且不在 `attemptedModels` 中的候选里选取下一个模型，触发类型记为 `failover`。

### `continuation`

默认保持当前模型并原样返回 `request.state`。以下情况重新决策：

- 当前模型进入冷却或不再满足上下文容量：直接切换到默认 / 回退模型，触发类型记为 `failover`。
- 本轮尾部连续工具错误达到 `redecideOnConsecutiveToolErrors`。
- 自上次决策起的步数达到 `periodicReviewSteps`。
- `stickyDuringToolLoop` 为 `false`。

`protectThinkingSignature` 开启且本轮已有 thinking 块时，周期复查与非粘性重决策被锁定；连续工具错误仍可触发。原因：Pi 在切换到任何其他模型（即便同一提供商）时会丢弃上一模型的 thinking 块与签名。

重决策后仍需通过切换收益门控（`switch_benefit` 与 `minSwitchBenefitConfidence`）才会实际切换。

### `user`

- 首次决策：调用分类器选择模型与思考强度。
- 后续消息：`redecideOnTaskShift` 关闭时保持当前模型；开启时调用分类器，并经过切换收益门控决定是否切换。
- 仅有 1 个可用候选时跳过分类器。
- 分类器不可用、超时或置信度不足时回退到当前健康模型或默认模型，触发类型记为 `fallback`。
- `observe` 模式记录分类器推荐，实际派发默认模型。

## 健康管理

`classifyModelFailure` 将错误分为 `rate_limit`、`unavailable`、`timeout`、`network`、`auth`、`missing`、`parameter`、`context_overflow`、`aborted`、`unknown`：

- `aborted` 与 `context_overflow` 不冷却。
- `unknown` 仅在 `isRetryableAssistantError` 判定为可重试时冷却。
- 冷却时长按连续失败次数指数退避，上限 `maxCooldownSeconds`；认证类错误直接采用上限。
- 同一模型同类错误在 `1500ms` 内只记录一次（`message_end` 与 `retry` 可能重复上报）。
- 成功响应立即清除冷却记录。

## 决策分类器

### 分类器链顺序

1. 自定义端点（`provider` 为 `auto`、`custom` 或与端点 `providerId` 相同时）。
2. 显式配置的 `provider/model`（支持旧版别名映射）。
3. `classifier.fallbackChain`。
4. 内置优先列表 `AUTO_CLASSIFIER_PRECEDENCE`。
5. 其余所有可用的 `type: "classifier"` 模型。

`runClassifierDecision` 依次尝试，每个分类器独立超时；响应中的选项必须属于已声明候选且置信度在 `[0, 1]` 内，否则尝试下一个。全部失败时返回 `undefined`，路由器回退，不抛异常。

### 自定义端点

`resolveCustomClassifierTarget` 解析 `customEndpoint`（`importFromPiClassifier` 时只读读取全局 `settings.json` 的 `classifier.baseUrl` / `classifier.model`），`registerCustomClassifierEndpoint` 以 `pi.registerProvider` 注册 `type: "classifier"` 模型。密钥引用顺序：`apiKeyEnv` > 已设置的 `CLASSIFIER_API_KEY` > 已设置的 `TYPESAFE_API_KEY` > `$CLASSIFIER_API_KEY`。端点被清除或更换 `providerId` 时，`index.ts` 调用 `pi.unregisterProvider` 注销旧注册。

### 提问结构

每次决策发送紧凑摘要（最近用户请求、轮次步数、连续工具错误、当前模型），不发送系统提示词与大段工具输出。问题包括：

- `model`：候选模型 `provider/id` 选项，附画像描述。
- `effort`：`config.efforts` 中的思考强度标签。
- `switch_benefit`（已有健康当前模型时）：`hold` / `upgrade_quality` / `optimize_speed_cost`。

## 扩展开发说明

- 新增配置字段：在 `types.ts` 声明类型与补丁类型，在 `constants.ts` 提供默认值，在 `mergeAndValidateConfig` 增加校验；候选模型画像字段还需加入 `PROFILE_OVERRIDE_FIELDS`。
- 新增命令：在 `commands.ts` 中通过 `applyConfigPatch` 写入，只传递变更字段，并补充自动补全项。
- 修改路由分支：保持“状态未变化时返回原引用”的约束，并在 `test/router.test.ts` 覆盖对应分支。
- 所有文件读写测试必须使用 `os.tmpdir()` 下的临时目录，并通过 `PI_CODING_AGENT_DIR` 隔离全局配置。

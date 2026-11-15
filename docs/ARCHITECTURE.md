# Pi-Fusion 架构说明

## 核心机制

Pi-Fusion 通过 `pi.registerVirtualModel` 注册虚拟模型 `router/fusion`，在 `route(request, ctx)` 回调中返回目标物理模型与 `thinkingLevel`，并将不可跨会话的路由状态（`FusionRouteState`）交由 Pi 持久化在会话分支的 `pi.virtual-model-state` 条目中。

## 模块职责

- `src/types.ts`：定义配置、状态、健康快照与决策输入输出契约。
- `src/constants.ts`：默认配置、家族启发式字典、故障识别正则与限制常量。
- `src/config.ts`：负责默认/全局/项目三层配置合并、参数校验、旧版三档配置迁移及跨平台原子写入。
- `src/health.ts`：维护模型故障冷却表、`1500ms` 防抖去重与指数退避策略。
- `src/catalog.ts`：解析候选模型池（支持显式配置与 Registry 自动发现）、健康过滤、上下文窗口容量守卫与大池预收敛。
- `src/effort.ts`：按 `thinkingMode` 与物理模型 `thinkingLevelMap` 解析并 Clamp 最终思考强度。
- `src/classifier.ts`：自动发现可用分类器链、构造紧凑摘要提示、严格校验分类器响应、带超时和备用链容错执行 `ctx.modelRegistry.classify()`。
- `src/policy.ts`：封装步数与连续工具错误统计、Thinking 签名保护、周期复查条件评估及切换收益门控（Benefit Gate）。
- `src/router.ts`：实现 `direct` / `retry` / `continuation` / `user` 四分支路由状态机与 Sticky Routing。
- `src/ui.ts`：状态栏展示、切换通知与基于 `@earendil-works/pi-tui` `SettingsList` 的交互式设置面板。
- `src/commands.ts`：实现 `/fusion` 与 `/router` 系列子命令及自动补全。
- `src/index.ts`：扩展入口，绑定生命周期钩子并注册虚拟模型与命令。

## 路由状态机流转

1. **`direct` 分支**：用于 Compaction 摘要等 Agent 循环外调用。跳过分类器，优先选取当前模型或轻量级健康模型，思考强度限制在 `off` 或 `low`，返回结果不含 `state`。
2. **`retry` 分支**：捕获 `request.failed` 的 `stopReason` 与 `errorMessage`，更新健康冷却表。若开启 `autoFailover`，从健康且未在 `attemptedModels` 中的候选中选取备用模型执行故障转移。
3. **`continuation` 分支**：默认保持 Sticky 模型并原样返回 `request.state` 引用以保护 Prompt 缓存与避免冗余会话条目。仅在当前模型进入冷却、连续工具报错达到阈值或满足周期复查条件（且未触发 Thinking 签名锁定）时重新调用分类器。
4. **`user` 分支**：对新用户指令调用分类器同步评估目标模型、思考强度与切换收益（`switch_benefit`）。当会话已有健康模型且切换收益未达阈值时，保持当前模型。

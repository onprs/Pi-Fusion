# Pi-Fusion Router

`pi-fusion-router` 是面向 Pi Coding Agent 的多模型动态路由器。选择虚拟模型 `router/fusion` 后，路由器会根据任务复杂度、上下文与偏好设置，自动为每次请求匹配最合适的物理模型与思考深度。

## 功能特性

- **统一虚拟入口**：提供 `router/fusion` 模型入口，按每次请求自动派发至最合适的物理模型。
- **任意规模候选池**：支持自定义 1 至 32 个候选模型画像，未配置时自动发现所有已就绪的物理模型。
- **专用决策驱动**：支持 TypeSafe Jev、Cloudflare Clef、OpenAI Decisions 等专用决策模型，并支持自定义端点与备用决策链。
- **连续任务保持与智能切换**：在连续工具执行期间默认保持当前模型；遇到连续报错、周期检查或任务切换时再评估是否升级或降级。
- **故障冷却与自动转移**：遇到限流、超时或上游不可用时自动冷却并切换备用模型，恢复后自动重新启用。
- **自动思考深度适配**：根据任务难度与各模型支持的思考档位自动选择最匹配的思考深度。

## 环境要求

- Node.js >= 22
- Pi Coding Agent 1.5.2 或更高版本
- 已配置至少 1 个可用物理模型凭据；建议同时配置 1 个专用决策模型凭据（或自定义决策端点），未配置时路由器使用默认模型

## 安装与使用

### 通过 GitHub 安装

```bash
pi install git:github.com/onprs/Pi-Fusion
```

### 通过 npm 安装

```bash
pi install npm:pi-fusion-router
```

### 从本地源码加载

```bash
pi -e ./src/index.ts --model router/fusion
```

启动后可在 `/model` 中选择 `router/fusion`，或在 CLI 参数中指定 `--model router/fusion`。

## 配置说明

配置文件采用分层合并策略（项目配置覆盖全局配置）：

- 全局配置：`~/.pi/agent/fusion-router.json`
- 项目配置：`<project>/.pi/fusion-router.json`

完整配置示例见 [`examples/fusion-router.example.json`](./examples/fusion-router.example.json)。未创建配置文件时，路由器会自动发现当前已配置的可用模型并启用默认策略。

通过命令或设置面板修改配置时，仅将变更项写入所选的配置文件；存在项目配置时默认写入项目配置。

### 自定义决策端点

使用 `/fusion classifier endpoint <baseUrl> [api] [密钥环境变量]` 配置兼容的决策端点：

- `api` 可选 `typesafe-system-one`（默认）、`cloudflare-workers-ai-system-one`、`openai-decisions`
- 未指定密钥环境变量时，依次使用已设置的 `CLASSIFIER_API_KEY`、`TYPESAFE_API_KEY`

### 运行模式

- `auto`：自动按决策结果派发物理模型与思考深度。
- `observe`：记录决策推荐结果但实际使用默认模型，便于在切换前评估路由效果。

## 斜杠命令

在 Pi 交互界面中输入 `/fusion`（或 `/router`）即可管理路由器：

- `/fusion`：打开横向分区固定列表路由控制中心（支持 `←`/`→`、`Tab` 或数字键切换「概览与诊断」「路由策略」「模型与分类器」「健康与测试」分区，全宽列表同排展示配置项、状态与简明说明）
- `/fusion config`：打开 3 分区固定列表路由策略与界面设置面板
- `/fusion status`：查看当前路由状态、决策模型、冷却中的模型与配置文件路径
- `/fusion explain`：查看最近一次路由决策详情（触发原因、推荐模型、置信度、切换收益与耗时）
- `/fusion models`：打开候选模型管理菜单（启用/停用、设为默认、修改优先级、成本档位、默认思考强度、擅长场景、不适用场景与显示名称）
- `/fusion models list`：列出候选模型池及健康状态
- `/fusion models import`：导入当前已认证物理模型至配置文件
- `/fusion models enable|disable <provider/model>`：启用或停用候选模型
- `/fusion models default <provider/model|clear>`：设置或清除默认回退模型
- `/fusion models set <provider/model> <字段> <值>`：修改 `priority`、`costTier`、`thinking`、`specialty`、`avoid`、`label`
- `/fusion classifier`：打开决策分类器管理菜单（查看分类器链、切换决策模型、配置/导入/清除自定义端点、调整超时与最低置信度）；`/fusion classifier list` 列出可用决策模型链
- `/fusion classifier <auto|provider/model>`：切换为自动发现或指定决策模型
- `/fusion classifier endpoint <baseUrl|clear>`：配置或清除自定义决策端点
- `/fusion classifier import`：导入全局分类器端点设置
- `/fusion health [manage | reset [provider/model]]`：查看健康状态、打开健康与冷却管理菜单或重置模型冷却记录
- `/fusion mode <auto|observe|on|off>`：切换运行模式或启停路由
- `/fusion enable` / `/fusion disable`：启用或停用动态路由
- `/fusion reload`：重新加载配置文件
- `/fusion test [文本]`：执行一次干跑路由决策测试

## 致谢

本项目的设计思路与部分实现借鉴了以下开源 Pi 扩展项目：

- `yeliu84/pi-model-router`
- `theogrillat/pi-precision-router`
- `green-dalii/pi-shift-router`
- `miketropi/pi-jev-model-manager`

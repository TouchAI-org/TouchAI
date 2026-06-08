# App Use / 软件控制设计文档

关联 issue: https://github.com/TouchAI-org/TouchAI/issues/417

## 1. 功能定义

**软件控制** 是 TouchAI 面向本地桌面应用的结构化使用能力，英文名为 **App Use**。

它的目标不是让模型直接执行 COM、VBA、JS、UXP、脚本或宏，而是把这些不同宿主的技术入口封装成安全、可审计、可配置的应用适配器，让模型通过统一的工具读取和操作受支持的软件。

| 能力 | 定义 |
| --- | --- |
| Computer Use | 观察屏幕并执行通用鼠标、键盘动作 |
| Browser Use | 通过浏览器协议控制浏览器 |
| App Use / 软件控制 | 通过结构化应用接口使用本地软件 |

因此，#417 不应定义成“COM 集成”，而应定义成 **App Use / 软件控制**。COM、Office 对象模型、WPS JSAPI、Photoshop UXP、Illustrator scripting 等只是 adapter 内部可能使用的实现机制。

## 2. 命名

| 场景 | 名称 |
| --- | --- |
| 中文产品名 | 软件控制 |
| 英文产品名 | App Use |
| 内部工具前缀 | `app_*` |
| 模型工具 | `app_session`, `app_observe`, `app_act` |
| 原生模块建议 | `core::app_use` |

不使用 `software_control` 作为工具前缀，避免中英文体系分裂。

## 3. 总体目标

1. 建立一套稳定的内置工具接口，用于发现、读取和操作受支持的本地应用。
2. 支持首批应用族：Microsoft Office、WPS Office、Photoshop、Illustrator。
3. 支持按应用族启用、禁用和配置能力。
4. 默认关闭，启用后也默认偏向只读模式。
5. 所有写入或可能改变应用状态的动作都需要审批。
6. 所有操作都记录目标应用、目标文档、动作、审批状态、结果摘要。
7. 不向模型暴露 raw script、raw COM、raw VBA、raw UXP batchPlay、宏或任意宿主命令。
8. 不做 Windows UI Automation fallback；这属于 Computer Use，不属于软件控制。
9. #417 的完整目标是分阶段实现 P0 到 P8 的全部能力；第一阶段只负责打底，不代表最终范围收缩。
10. 先建立框架，再按 adapter 一点点实现具体功能，确保后续 Office/WPS 写动作、Adobe 深化、高级工作流和 adapter 扩展规范都能继续落地。

## 4. 非目标

1. 不在 #417 中实现通用屏幕点击、键盘输入或 UI Automation 兜底。
2. 不允许模型提交任意脚本让宿主应用执行。
3. 不支持后台隐藏文档的无感修改。
4. 不支持宏执行、宏创建、插件安装、加载项安装。
5. 不在第一阶段做完整 Adobe 批处理自动化。
6. 不在第一阶段做跨平台实现；首版以 Windows 为主。
7. 不把一次工具调用设计成长时间自主循环；每次 `app_act` 只执行一个有界动作。

## 5. 分阶段路线

| 阶段 | 目标 | 范围 |
| --- | --- | --- |
| P0 定义与框架 | 建立 App Use / 软件控制边界 | 工具命名、adapter 架构、风险分级、日志、测试骨架 |
| P1 设置系统 | 添加软件控制独立设置 tab | 总开关、按软件启用、只读模式、审批策略、超时、输出限制 |
| P2 软件发现 | 发现可控软件和当前文档 | 是否安装、是否运行、当前活动文档、adapter 能力 |
| P3 结构化读取 | 读取应用上下文 | 文档、选区、工作表、幻灯片、图层、画板等信息 |
| P4 审批治理 | 写动作统一审批 | 目标软件、目标文件、动作说明、影响预览、日志 |
| P5 Office/WPS 写动作 | 第一批实用闭环 | 插入/替换文本、读写单元格、简单幻灯片文本操作 |
| P6 Computer Use 边界 | 明确不在 App Use 中实现 | 通用屏幕观察、鼠标键盘、前台 UI Automation 兜底属于 Computer Use，不作为软件控制功能 |
| P7 高级工作流 | 扩展复杂软件任务 | 导出、批处理、格式调整、跨软件联动；Adobe 若增加轻动作也必须限定在结构化 adapter 内 |
| P8 Adapter 扩展规范 | 支持长期扩展 | 新 adapter 接入规范、测试规范、风险策略、示例 |

## 6. 工具设计

模型只看到三个主工具：

| 工具 | 用途 |
| --- | --- |
| `app_session` | 发现软件、查看 adapter 状态、列出当前可用目标和能力 |
| `app_observe` | 读取当前应用、文档、选区、表格、幻灯片、图层、画板等结构化上下文 |
| `app_act` | 执行一个受控动作；写动作或高风险动作必须审批 |

三个工具都应该接受 `description` 字段，用来让模型说明这次操作的意图，并展示到审批 UI 和日志里。

工具参数里应使用 adapter id，而不是暴露底层实现方式。例如使用 `office_word`，而不是 `word_com`。

## 7. 首批 Adapter

| Adapter | 第一阶段能力 | 后续能力 |
| --- | --- | --- |
| `office_word` | 活动文档、文档名、选区文本、基础元数据 | 插入文本、替换选区、简单格式 |
| `office_excel` | 活动工作簿、工作表列表、选区、单元格读取 | 写单元格、写区域、简单表格操作 |
| `office_powerpoint` | 活动演示文稿、幻灯片列表、当前幻灯片文本 | 插入文本框、修改简单文本 |
| `wps_writer` | 对齐 Word 的读取能力 | 对齐 Word 的基础写动作 |
| `wps_spreadsheet` | 对齐 Excel 的读取能力 | 对齐 Excel 的基础写动作 |
| `wps_presentation` | 对齐 PowerPoint 的读取能力 | 对齐 PowerPoint 的基础写动作 |
| `photoshop` | 当前文档、画布尺寸、图层列表、当前图层 | 少量安全动作，如选择图层、导出前预览 |
| `illustrator` | 当前文档、画板、图层、选中对象摘要 | 少量安全动作，如选择对象、读取对象属性 |

Office/WPS 是第一批实用闭环重点。Adobe 先做 discovery 和 read-only observation；后续如增加轻动作，必须在 P7 之后以结构化 adapter 形式单独评估，不能滑向 P6 的通用 Computer Use。

## 8. 设置功能

软件控制必须默认关闭，并在设置中拥有独立 tab。它不应只藏在“内置工具”列表里的某个配置块中，因为后续会包含多个 adapter、权限策略、读取范围、审批策略、日志入口和高级能力开关。

| 设置项 | 默认值 | 说明 |
| --- | --- | --- |
| 软件控制总开关 | 关闭 | 未启用时不暴露任何 `app_*` 工具 |
| 按软件启用 | 全部关闭 | 用户分别启用 Office、WPS、Photoshop、Illustrator |
| 运行模式 | 只读优先 | 可只允许发现和读取，禁用写动作 |
| 写动作审批 | 始终审批 | v1 不提供免审批写动作 |
| 读取范围 | 当前活动应用/文档/选区 | 避免默认读取后台大量内容 |
| 后台操作 | 关闭 | 默认只操作前台或用户明确选择的目标 |
| raw script / macro | 禁止 | v1 不开放配置项 |
| 超时 | 短超时，可配置 | 防止 COM 或宿主 API 卡住执行循环 |
| 输出限制 | 截断长文本 | 避免把整篇文档塞进模型上下文 |
| 日志 | 跟随内置工具日志 | 记录 app、文档、动作、审批、结果 |

软件控制 tab 内部应把 `app_session`、`app_observe`、`app_act` 作为同一个能力组管理，避免出现只启用一部分工具导致能力不完整的状态。这个 tab 至少应包含：

1. 总开关和当前风险提示。
2. 应用 adapter 列表及每个 adapter 的启用状态。
3. 运行模式和审批策略。
4. 读取范围、后台操作、输出限制和超时配置。
5. 最近软件控制日志入口。
6. 后续高级能力入口，例如导出、批处理、跨软件工作流开关。

## 9. 架构设计

软件控制应沿用现有 built-in tool 管线：

1. TypeScript 侧定义 `app_session`、`app_observe`、`app_act` 的工具描述、schema、格式化和审批逻辑。
2. `BuiltInToolService` 继续负责启用状态、参数解析、审批、日志、事件和执行生命周期。
3. `NativeService` 提供薄封装，调用 Tauri command。
4. Rust 侧新增聚合模块，例如 `core::app_use`。
5. Rust 模块内部通过 adapter trait 分发到 Office、WPS、Photoshop、Illustrator。
6. adapter 返回结构化 observation 或 receipt，不返回宿主原始输出。

建议 Rust 模块结构：

```text
core/app_use/
  mod.rs
  types.rs
  runtime.rs
  adapters/
    mod.rs
    office.rs
    wps.rs
    photoshop.rs
    illustrator.rs
```

adapter 接口分为三类：

```text
discover() -> 应用状态、运行状态、能力列表
observe(request) -> 结构化上下文
act(request) -> 执行结果 receipt
```

Office/WPS 如果走 COM 或类似自动化接口，应使用 Windows STA 兼容的工作线程，避免阻塞 UI 线程。

## 10. 数据流

1. 模型调用 `app_session`，发现已启用 adapter、安装状态、运行状态和当前可用目标。
2. 模型调用 `app_observe`，读取某个 adapter 的当前文档或选区上下文。
3. TouchAI 返回结构化 observation，包含目标应用、文档、选区、能力和必要摘要。
4. 模型调用 `app_act`，请求一个有界动作。
5. TouchAI 根据设置和动作风险生成审批。
6. 用户批准后，Rust adapter 执行动作并返回 receipt。
7. TouchAI 记录日志，模型可以再次 observe 确认结果。

## 11. 审批与安全策略

`app_act` 在 v1 中所有写动作都需要审批。

审批 UI 应展示：

1. 应用名称和 adapter id。
2. 目标文档、工作簿、演示文稿、图层或画板。
3. 动作名称。
4. 模型提供的操作说明。
5. 变更预览，例如要插入的文本、要写入的单元格、要修改的幻灯片。
6. 风险标签和风险原因。

必须阻止：

1. raw script、宏、任意宿主命令。
2. 隐藏窗口或后台文档修改。
3. 删除文档、关闭不保存、覆盖导出、批量删除等破坏性动作。
4. 可识别的密码、凭据字段读取或写入。
5. 目标 app 在设置中未启用的请求。
6. 一次 `app_act` 中包含多个动作的请求。

读取结果应支持截断、摘要和敏感内容提示。需要读取更大范围时，应让模型再次请求更明确的范围。

## 12. 第一阶段实现范围

第一阶段建议实现 P0 到 P4 的框架，不急着实现大量写动作。它是完整 P0 到 P8 路线的第一步，不是最终交付边界。

交付内容：

1. 新增 `app_session`、`app_observe`、`app_act` built-in tool，默认关闭。
2. 新增软件控制设置模型和 Settings 独立 tab。
3. 新增 TypeScript schema、配置解析、结果格式化、审批构造。
4. 新增 NativeService 命令封装。
5. 新增 Rust `core::app_use` runtime 和 mockable adapter trait。
6. 实现或预留 Office/WPS/Photoshop/Illustrator 的 capability discovery。
7. 实现 read-only observation 的基础结构，至少能返回 active target metadata。
8. `app_act` 建立审批路径；具体写动作未实现时返回清晰拒绝或 unsupported。
9. 添加 TS 单测覆盖工具注册、设置、审批、格式化和 native wiring。
10. 添加 Rust mock adapter 测试覆盖 discover、observe、act gating、超时和 disabled-app 行为。

第一阶段验收标准：

1. 软件控制关闭时，模型看不到任何 `app_*` 工具。
2. 软件控制开启且处于只读模式时，`app_session` 和 `app_observe` 可工作。
3. 只读模式下 `app_act` 对写动作给出清晰拒绝。
4. 未启用的 adapter 不作为可操作目标返回。
5. 写动作开启后，所有 mutating action 都必须走审批。
6. 日志包含 app id、operation、status、approval state、result summary。
7. 任意模型可见 schema 都不接受 raw script 字段。

## 13. 后续实现顺序

后续目标仍然属于 #417 的整体规划，应按这个顺序逐步推进直到 P0 到 P8 全部完成：

1. 建立工具组、设置和日志框架。
2. 做 adapter runtime 和 mock 测试。
3. 做 `app_session` discovery。
4. 做 `app_observe` read-only 基础能力。
5. 打通 `app_act` 审批路径，但先不做复杂写动作。
6. 补 Office Word / WPS Writer 的选区文本读取和替换。
7. 补 Excel / WPS Spreadsheet 的选区和单元格读写。
8. 补 PowerPoint / WPS Presentation 的幻灯片文本读取和简单写入。
9. 补 Photoshop / Illustrator 的 read-only 深化。
10. 明确保留 P6 Computer Use 边界，不实现通用前台鼠标、键盘或 UI Automation fallback。
11. 实现高级工作流，例如导出、批处理、格式调整和跨软件联动；如需 Adobe 安全轻动作，应作为结构化 adapter 的高级工作流单独推进。
12. 补充 adapter 扩展规范，让新增软件可以按统一接口接入。

## 14. 测试计划

TypeScript 测试：

1. built-in tool 注册和启用状态。
2. 软件控制设置解析、序列化和默认值。
3. `app_session`、`app_observe`、`app_act` 工具组设置联动。
4. schema 拒绝 raw script 和隐藏字段。
5. 审批 payload 格式化。
6. observation 和 receipt 格式化、截断。
7. NativeService 命令调用参数。

Rust 测试：

1. runtime 分发到正确 adapter。
2. disabled adapter 拒绝。
3. mock discovery 和 observe 输出。
4. mutating action gating。
5. timeout 和 cancellation。
6. Windows ignored smoke tests：真实 Office/WPS/Adobe discovery。

完整 PR 前应跑仓库现有要求的验证命令；开发中优先跑 targeted tests。

## 15. 参考资料

1. #417: https://github.com/TouchAI-org/TouchAI/issues/417
2. Computer Use RFC #111: https://github.com/TouchAI-org/TouchAI/issues/111
3. Native computer tools PR #400: https://github.com/TouchAI-org/TouchAI/pull/400
4. Native browser tools PR #414: https://github.com/TouchAI-org/TouchAI/pull/414
5. Microsoft COM `CoInitializeEx`: https://learn.microsoft.com/en-us/windows/win32/api/combaseapi/nf-combaseapi-coinitializeex
6. Microsoft Office VBA object model: https://learn.microsoft.com/en-us/office/vba/api/overview/
7. WPS 开放平台: https://open.wps.cn/docs/
8. Photoshop UXP: https://developer.adobe.com/photoshop/uxp/
9. Illustrator scripting: https://ai-scripting.docsforadobe.dev/

## 16. 待确认问题

这些问题不阻塞执行；实现过程中会优先调研上游产品并自行决定，最终报告决策：

1. Adobe 是否进入第一阶段 discovery-only，还是等 Office/WPS 读取稳定后再进。
2. 读取完整选区文本是否需要审批，还是只对超过选区范围的读取请求审批。

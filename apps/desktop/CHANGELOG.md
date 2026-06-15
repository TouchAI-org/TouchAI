# 更新日志

## [1.1.1](https://github.com/TouchAI-org/TouchAI/compare/v1.1.0...v1.1.1) (2026-06-08)


### Bug Fixes

* **agent-service:** preserve network errors when provider classification fails ([#411](https://github.com/TouchAI-org/TouchAI/issues/411)) ([36044b6](https://github.com/TouchAI-org/TouchAI/commit/36044b6df0ff89b43c07e2585794728f41567a30))
* **agent:** classify localized cancellation errors ([#339](https://github.com/TouchAI-org/TouchAI/issues/339)) ([c3d675e](https://github.com/TouchAI-org/TouchAI/commit/c3d675ee5b21ca17a2f98223d4ae02e2776808ec))
* **agent:** sync switched model on active reattach ([#366](https://github.com/TouchAI-org/TouchAI/issues/366)) ([1ddc767](https://github.com/TouchAI-org/TouchAI/commit/1ddc767d81451377cd8e5161c1a12c4075a49791))
* **ai-sdk:** retain streamed tool call names ([#362](https://github.com/TouchAI-org/TouchAI/issues/362)) ([eb372b1](https://github.com/TouchAI-org/TouchAI/commit/eb372b18708778a031f8a71fb81a9d920232db3c))
* **desktop:** preserve message bubble line breaks ([#412](https://github.com/TouchAI-org/TouchAI/issues/412)) ([691b23a](https://github.com/TouchAI-org/TouchAI/commit/691b23a1fc8b3141887fc80104699b2a6f85ff93))
* **desktop:** prevent shell vars from rendering as math ([#419](https://github.com/TouchAI-org/TouchAI/issues/419)) ([bd98f76](https://github.com/TouchAI-org/TouchAI/commit/bd98f76b1fbf99c71879e847ef3d8e2502babca7))
* **markdown:** keep renderer mounted on final output ([#420](https://github.com/TouchAI-org/TouchAI/issues/420)) ([8287c9d](https://github.com/TouchAI-org/TouchAI/commit/8287c9da3637d0cd19fe31d3854402e319b5ca45))
* **sessions:** retain provider during metadata refresh ([#360](https://github.com/TouchAI-org/TouchAI/issues/360)) ([792512b](https://github.com/TouchAI-org/TouchAI/commit/792512b96dc18b185f12647a4f86558a5a6f0b47))
* **webfetch:** validate redirect targets ([#306](https://github.com/TouchAI-org/TouchAI/issues/306)) ([4e637a9](https://github.com/TouchAI-org/TouchAI/commit/4e637a992dbdfadcbf72f4e053518e164235fd62))

## [1.1.0](https://github.com/TouchAI-org/TouchAI/compare/v1.0.0...v1.1.0) (2026-06-03)


### Features

* **notification:** adjust approval reminder notification behavior ([#384](https://github.com/TouchAI-org/TouchAI/issues/384)) ([75b93d8](https://github.com/TouchAI-org/TouchAI/commit/75b93d82a6cf1963fe2169a909b3c40cf2653cd0))


### Bug Fixes

* **agent-service:** refresh model metadata on startup ([#383](https://github.com/TouchAI-org/TouchAI/issues/383)) ([fcb3cd9](https://github.com/TouchAI-org/TouchAI/commit/fcb3cd9c9afaf7dcf8d4d02693e8b55dc1937a05))
* **agent-service:** show friendly unsupported input errors ([#407](https://github.com/TouchAI-org/TouchAI/issues/407)) ([b35f7ce](https://github.com/TouchAI-org/TouchAI/commit/b35f7ce2ec26b368090a00faf6e13a00eebe3c4b))
* **desktop:** add win10 rounded corner fallback ([#403](https://github.com/TouchAI-org/TouchAI/issues/403)) ([4517de8](https://github.com/TouchAI-org/TouchAI/commit/4517de8cab416437de4176ec4332f4f9deb51061))
* **desktop:** improve cold startup first paint ([#401](https://github.com/TouchAI-org/TouchAI/issues/401)) ([1dd33ca](https://github.com/TouchAI-org/TouchAI/commit/1dd33cae8e54be364f2af05e2f801becbd733bf4))
* **desktop:** improve font loading diagnostics ([#405](https://github.com/TouchAI-org/TouchAI/issues/405)) ([e425600](https://github.com/TouchAI-org/TouchAI/commit/e425600f9dc64978f13c2353fac1f98a8a3513de))
* **desktop:** make font loading deterministic ([#392](https://github.com/TouchAI-org/TouchAI/issues/392)) ([7aef4f7](https://github.com/TouchAI-org/TouchAI/commit/7aef4f7f55c07f4b8c51074a467836e1aba38801))
* **desktop:** preserve generated visualization styling ([#387](https://github.com/TouchAI-org/TouchAI/issues/387)) ([edac12c](https://github.com/TouchAI-org/TouchAI/commit/edac12ccdc66d6e21b1de2b3709f17f33e427ec1))
* **search:** center single-line search bar content ([#399](https://github.com/TouchAI-org/TouchAI/issues/399)) ([04650bb](https://github.com/TouchAI-org/TouchAI/commit/04650bb93b4d6a17efbbc986dc75d7ce30374b89))
* **search:** remeasure window height on activation ([#382](https://github.com/TouchAI-org/TouchAI/issues/382)) ([d71a223](https://github.com/TouchAI-org/TouchAI/commit/d71a22310839a2003bbe88d553cf70f2447bd9e3))

## [1.0.0](https://github.com/TouchAI-org/TouchAI/compare/v0.1.0...v1.0.0) (2026-06-02)

经过半年的密集开发，我们很高兴地宣布 **TouchAI 1.0.0** 正式发布！我们定义它为下一代桌面效率Agent，专为提升你的Agent使用效率设计。

## ✨ 核心亮点

### **1. 一触即达，不打断工作流**
- **全局快捷键唤起**：`Alt+Space` 召之即来挥之即去，AI 始终在你身边。
- **全键盘操作**：无需鼠标，纯键盘即可完成所有交互。
- **智能窗口伸缩**：输入时小巧不遮挡，响应时自动展开，始终处于最佳位置。

### **2. 桌面上下文，更懂你的需求**
- **文件感知**：智能识别当前桌面文件、剪贴板、窗口等上下文信息。
- **附件投递**：支持拖拽/粘贴文件附件，AI 直接读取并理解内容。
- **文件检索**：内置 ripgrep，支持连接Everything，轻松检索全机。

### **3. 从对话到执行，真正“有用”的桌面 Agent**
- **真实工具调用**：不只是聊天，TouchAI 能直接操作文件、执行命令、检索信息。
- **内置精简工具**：文件读写、Bash 执行、网页浏览、文件搜索、可视化等。
- **可视化交互 UI**：Widget 渲染引擎支持图表、流程图等丰富可视化内容。

### **4. 灵活的模型与扩展**
- **BYOK 支持**：自带 API 密钥，无厂商锁定，自由切换服务商。
- **MCP 支持**：连接更广阔的工具生态，无限扩展 Agent 能力。

---

## 📍 功能预告

v1.0.0 只是开始。接下来我们将继续重磅增强 Agent 能力：

- **Skills** — 技能市场，按需安装，扩展 Agent 能力边界
- **CDP（Chrome DevTools Protocol）** — 深度浏览器控制与自动化
- **Computer Use** — 桌面操作自动化，AI 直接操控你的电脑
- **记忆系统** — 长期记忆与个性化上下文，越用越懂你
- **MiniApp 生态** — 更丰富的可视化应用与交互体验
- **自动化工作流** — 定时任务与触发器编排，解放重复劳动

更多能力持续开放中，敬请期待，也欢迎更多朋友参与贡献！

---

## 🙏 特别致谢

感谢所有为 TouchAI v1.0.0 做出贡献的开发者：

**核心维护者：** @hiqiancheng

**社区贡献：** @ThunderTr77, @sakukae, @TheEverests, @jiang171, @ARCJ137442, @velga111, @CelesteLP, @cjc0013, @icy-bean, @snowjuly, @xlocalvn-svg, @karry-083

---

## 📥 立即体验

**下载地址：** [GitHub Releases](https://github.com/TouchAI-org/TouchAI/releases)

**系统要求：**
- Windows 10/11
- macOS 12+
- Linux（Ubuntu 20.04+, Fedora 35+）

---

## 💬 反馈与支持

如有任何疑问、建议或问题：
- 提交 [Issue](https://github.com/TouchAI-org/TouchAI/issues)

---

# Changelog

## [1.0.0](https://github.com/TouchAI-org/TouchAI/compare/v0.1.0...v1.0.0) (2026-06-02)

After six months of intensive development, we are thrilled to announce the official release of **TouchAI v1.0.0**! We define it as the next-generation desktop productivity Agent, purpose-built to supercharge your Agent workflow.

## ✨ Highlights

### **1. One-Touch Access, Zero Workflow Interruption**
- **Global hotkey activation**: `Alt+Space` — summon and dismiss instantly. AI is always within reach.
- **Full keyboard control**: Complete every interaction with your keyboard alone, no mouse required.
- **Smart window resizing**: Compact when you're typing so it never blocks your work, auto-expands when the response is ready, always in the optimal position.

### **2. Desktop Context, Smarter Responses**
- **File awareness**: Intelligently detects current desktop files, clipboard content, active windows, and other contextual information.
- **Attachment drop-off**: Drag-and-drop or paste file attachments; the AI reads and understands the content directly.
- **File search**: Built-in ripgrep and Everything integration for lightning-fast full-machine search.

### **3. From Conversation to Execution — A Truly "Useful" Desktop Agent**
- **Real tool calls**: Not just a chatbot — TouchAI operates files, executes commands, and retrieves information directly.
- **Built-in lightweight tools**: File read/write, Bash execution, web browsing, file search, visualization, and more.
- **Interactive visual UI**: The Widget rendering engine supports rich visualizations including charts, flowcharts, and more.

### **4. Flexible Models & Extensions**
- **BYOK (Bring Your Own Key)**: Bring your own API key — no vendor lock-in, freely switch between providers.
- **MCP support**: Connect to a broader ecosystem of tools, infinitely extend your Agent's capabilities.

## 📍 What's Coming Next

v1.0.0 is just the beginning. We will continue to massively enhance Agent capabilities:

- **Skills** — A skill marketplace: install on demand to extend the boundaries of your Agent.
- **CDP (Chrome DevTools Protocol)** — Deep browser control and automation.
- **Computer Use** — Desktop automation, letting AI directly control your computer.
- **Memory System** — Long-term memory and personalized context, getting smarter the more you use it.
- **MiniApp Ecosystem** — Richer visual apps and interactive experiences.
- **Automation Workflows** — Scheduled tasks and trigger orchestration to eliminate repetitive work.

More capabilities are continuously rolling out — stay tuned! Contributions from the community are always welcome.

---

## 🙏 Special Thanks

A heartfelt thank-you to everyone who contributed to TouchAI v1.0.0:

**Core Maintainer:** @hiqiancheng

**Community Contributors:** @ThunderTr77, @sakukae, @TheEverests, @jiang171, @ARCJ137442, @velga111, @CelesteLP, @cjc0013, @icy-bean, @snowjuly, @xlocalvn-svg, @karry-083

---

## 📥 Get It Now

**Download:** [GitHub Releases](https://github.com/TouchAI-org/TouchAI/releases)

**System Requirements:**
- Windows 10/11
- macOS 12+
- Linux (Ubuntu 20.04+, Fedora 35+)

---

## 💬 Feedback & Support

For any questions, suggestions, or issues:
- Submit an [Issue](https://github.com/TouchAI-org/TouchAI/issues)

---

**TouchAI v1.0.0 — Not just conversation, but action.**

[Download Now](https://github.com/TouchAI-org/TouchAI/releases) · [Open Source](https://github.com/TouchAI-org/TouchAI) · [Feedback](https://github.com/TouchAI-org/TouchAI/issues)

# 前端依赖升级：修复记录与验收清单

更新时间：2026-10-07。本文件记录本地 worktree 的开发验证，不代表已发布或人工验收通过。

## 1. 范围与结论

- worktree：`D:\Project\TouchAI\dependency-upgrade-origin-main`。
- 分支：`chore/frontend-dependency-upgrade-main`，对比基线 `ff56a277`。
- No new issue was created; this PR is linked to existing issue `#194`.
- 保留新版依赖，不以降级恢复旧外观。当前对基线 118 项直接依赖的比较：68 项升级、50 项不变、0 项降级；新增 `stream-diffs` 和显式 Vue SFC 编译器依赖。
- 已修复并实测 Markdown 代码块的运行时缺失、Shadow DOM 外观变化、主题参数顺序和长代码永久占位问题。
- **安全与验收边界**：2026-10-07 官方审计显示生产依赖 0 条 advisory，开发/测试工具链仍有 5 条已知告警（4 high、1 moderate）；`pnpm test:pr` 全部通过，但 C01/C05 实际流式人工验收仍开放。详见第 6、10 节。

## 2. 主要依赖状态

以下为锁文件实际版本，而不只是 `package.json` 的范围：

| 依赖                   | 当前版本/说明                                        |
| ---------------------- | ---------------------------------------------------- |
| Vue / Vue SFC compiler | 3.5.43，同版本；Router 与应用实际解析到同一 Vue 模块 |
| vue-router             | 5.2.0，未降回 4.x                                    |
| markstream-vue         | 1.0.6，未降回旧渲染器                                |
| stream-monaco          | 0.0.49，仍保留，但不能代替新版运行时                 |
| stream-diffs           | 新增 0.0.2，使用真实发布包，不是自造兼容模块         |
| @pierre/diffs          | 1.5.2，stream-diffs 的渲染依赖                       |
| Tiptap 系列            | 3.31.4                                               |
| reka-ui / motion-v     | 2.11.0 / 2.6.0                                       |
| Vite / Vitest          | 8.3.3 / 4.1.11                                       |
| @tauri-apps/cli        | 2.11.3，Rust 依赖未修改                              |
| @tauri-apps/api        | 2.11.1，与 Rust tauri 2.11.1 配套                    |
| Astro / @astrojs/react | 7.3.6 / 7.0.1                                        |

另对仍在使用的传递依赖按上游允许范围重新解析，修正 tinyexec、semver、tinyglobby、obug、picomatch 等调用链选到比基线旧版本的问题。通过 scoped overrides 约束两条链：

- `@types/sax>@types/node: ^25.9.9`：上游允许 `*`，避免去重到 24.x；不改变 WDIO 自己的 20.x 类型分支。
- `@wdio/config>glob: ^10.5.0`：上游允许 `^10.2.2`，避免解析回 10.4.5，不跨 major。

最终直接依赖比对和“父包相同主版本的依赖边最高版本”聚合检查均没有下降；后者是排查用启发式统计，不是所有调用链等价或安全性的证明。依赖树不再需要的高主版本分支被移除，不应误判为同一调用链降级；没有为保留无用分支而强行跨主版本 override。证据为 `direct-versions-final.json`、`dependency-edges-final.json`。

**Tauri 配套边界**：全量更新曾临时选中 API 2.12.1 及插件的新 minor，完整 Tauri 构建明确拒绝其与当前 Rust 端的版本组合。没有绕过检查，也没有扩大本次范围去升级 Rust。最终 JS 范围限定在与 Rust 配套的 minor（使用 `~`），API/部分插件升级兼容补丁版；所有最终直接依赖均不低于基线。插件最终版本：dialog 2.7.3、fs 2.5.2、http 2.5.9、notification 2.3.3、opener 2.5.5、process 2.3.1。这不是回退 Vue、Markdown 或其他 UI 升级。

## 3. 样式回归根因与修复

### 3.1 缺少新版真实代码块运行时

`markstream-vue@1.0.6/dist/monaco.js` 实际动态加载 `stream-diffs`。加载失败时会退回普通 `<pre>`，因此工具栏、增强渲染、外观及交互同时变化。原来存在 `stream-monaco` 并不说明新版 runtime 完整。

修复：在桌面应用直接声明 `stream-diffs@0.0.2`。新增测试读取真实动态 import，以 ESM 方式从渲染器所在目录加载模块，并检查 manifest 显式依赖；不使用会误判 import-only exports 的 `require.resolve`。

### 3.2 新 File/Diff 渲染器使用 Shadow DOM

旧 Monaco CSS 不能直接覆盖新渲染器内部。修复分三处：

- `MarkdownContent.vue` 传入旧版代码字体：Consolas / Courier New、14px、19px 行高。
- `markdown.css` 通过 `diffs-container` 的 CSS 自定义属性传递暖色背景、文字与行号色、字体和间距，避免 Vue 更新父级 style 时覆盖适配器的设置。
- 新增静态 `markdown-code-surface.css`，通过公开的 `unsafeCSS` 接口调整普通文件代码块的行号栏和左侧缩进。此 CSS 来自构建时静态文件，**不拼接用户或模型返回内容**；选择器限于 `pre[data-file]`，不覆盖 diff 双栏布局。

### 3.3 主题数组顺序变化

新运行时把数组解释为 `[dark, light]`，而不是无序主题列表。原顺序会让浅色界面使用错误主题语义。已改为 `['one-dark-pro', 'one-light']`。

### 3.4 超长行会永久停留在 loading `<pre>`

真实浏览器复现：新版 viewport root 查找从元素自身开始；有横向溢出的占位 `<pre>` 被当作自己的 IntersectionObserver root，导致可见代码仍报告不相交，且不允许 idle 初始化。

通过组件公开 API 设置 `viewport-priority=false`，避免这条错误延迟初始化路径；仍保留分批渲染和原有 `maxLiveNodes`（普通消息 0，reasoning 320）。

**取舍**：离屏重组件会更早初始化。不能用短文本回归证明长历史记录性能不变，长聊天性能仍需专项验收。

## 4. 安装与工具链修复

4 组设置页测试曾因 `@vue/compiler-sfc` 无法从图标编译插件的上下文加载而失败。最终证据表明：pnpm 的 `.modules.yaml` 记录已有私有 hoist，但磁盘缺少实际 junction。仅新增直接依赖并不能修复该状态。

使用冻结锁文件的强制离线重装重建链接后，4 组、26 项测试全部通过；没有修改测试以绕过图标编译。显式 SFC compiler 开发依赖与 Vue 3.5.43 对齐。安装使用 `--ignore-scripts`，没有为修复链接运行不必要的安装脚本。

## 5. 自动化与开发自测

### 正式检查

| 检查                      | 实际结果/边界                                                                  |
| ------------------------- | ------------------------------------------------------------------------------ |
| 全 workspace 直接依赖比对 | 118 项原有依赖，0 项降级                                                       |
| Vue 模块解析              | Router 与应用共用 Vue 3.5.43                                                   |
| 应用类型检查              | 通过（桌面 build 包含 vue-tsc）                                                |
| 测试类型检查              | 通过                                                                           |
| ESLint                    | 0 error、20 warning；warning 未在此次扩大范围处理                              |
| 全量 Vitest               | 161 个测试文件、1013 项全部通过；coverage 重跑也通过                             |
| Markdown 新增回归         | 已包含在全量测试通过项中，runtime 真实 ESM 加载和组件配置均有断言              |
| 桌面生产前端构建          | 通过；保留大 chunk 和 bundler timing 警告，不把警告说成不存在                  |
| 官网生产构建              | 通过；有 i18n collection 为空的警告，网站体验单独验收                          |
| 完整 Tauri 软件           | `tauri build --debug --no-bundle` 通过；运行内嵌生产页面，详见第 7 节          |
| 改动文件格式 / diff       | 修改的 Vue/CSS/测试 Prettier 检查通过；文档单独格式化；`git diff --check` 通过 |

首次 `pnpm test:pr` 在 Rust build script 下载 RTK 时遇到 GitHub 网络超时（10060），未涉及代码失败；网络恢复后原命令完整重跑通过。测试已隔离本地真实 Git 标签状态，不改发布逻辑，也不删除标签。

### 真实浏览器旧版/新版对照

隔离 harness 位于 gitignored 的 `.tmp/markdown-regression/`，测试使用实际 Vue 组件与渲染包，不是 MarkdownRender stub。旧版包从主工作区只读加载，组件从 Git 基线读取。比较结果只覆盖该 fixture，不等于完整桌面所有界面像素一致。

已验证：

- 正文字体、15px 字号、30.75px 行高、暖色配色。
- 代码 14px / 19px、暖色背景、行号颜色、浅色 theme、左侧缩进。
- 工具栏高度一致；两行示例代码块总高度旧版 86.59375px、新版 85.59375px，仍有 1px 差异，**不是逐像素完全相同**。
- 复制、折叠、展开、流式追加、结束后复制完整代码。
- 清空后重新挂载必须出现富代码块和复制工具栏，不能仅由 fallback 文本满足断言。
- 多代码块隔离；780px / 420px 视口下超长行仅横向滚动、不自动折行，页面不横向溢出（按本轮新要求更新）。
- 120 行长代码：500px 容器内可滚动到底部，复制不截断。
- 流式结束切换逐帧检查：示例高度稳定，无文本消失。
- `<script>` / `<img onerror>` 作为 HTML 代码显示时不执行，不自动打开预览。
- 上述场景未捕获浏览器 pageerror。

边界：浏览器 fixture 的剪贴板为 mock，不证明系统剪贴板；Mermaid 等 external，不证明图表/公式/预览功能；不替代真实 WebView、输入法、托盘、快捷键测试。

本地证据：`comparison.json`、`geometry.json`、`interactions.json`、`extended-interactions.json`、`legacy.png`、`current.png` 及各检查日志，均位于 `.tmp/markdown-regression/`。

## 6. 安全审计（生产依赖与开发工具链分开报告）

早期官方 `pnpm audit --json` 曾报告 62 条 advisory（35 high、22 moderate、5 low）。更新后于 2026-10-07 再次在线审计当前锁文件：全量依赖为 4 high、1 moderate、0 low/critical，共 5 条，均位于开发/测试/E2E 工具链；`pnpm audit --prod --json` 同次成功返回 0 条各级别 advisory。生产扫描结果只表示当前 npm advisory 数据库对 production 依赖树未报告已知问题，不构成绝对安全保证。

已按上游范围更新 `undici`、`brace-expansion`、`fast-uri`、`ip-address`、`fflate` 等；Vitest 的可选 happy-dom 以同主版本 override 固定到 20.8.9。当前 5 条开发依赖告警及处理边界：

| 包/调用链                            | 剩余情况与处理                                      |
| ------------------------------------ | --------------------------------------------------- |
| esbuild 0.18.20 / drizzle-kit loader | 开发服务器告警；修复需到 >=0.25，未盲目强制跨 minor |
| extract-zip 2.0.1 / WDIO → Puppeteer | 两条归档路径/符号链接告警，报告无修复版本           |
| basic-ftp 5.3.1 / WDIO proxy 链      | 目录列表解析 DoS，修复需 >=6.2.1，未强制跨 major    |
| braces 3.0.3 / WDIO → Mocha          | 深层模式栈耗尽，报告无修复版本                      |

全量审计与 `--prod` 审计本轮均已成功在线完成；先前记录的 TLS `ECONNRESET` 是较早重试的临时网络失败，不是最终结果。由于剩余告警均在开发工具链，运行本地开发服务器、WDIO/Puppeteer 或处理不可信归档/FTP 输入时仍应谨慎；持续跟进上游修复或替换路径。

审计命令：`pnpm audit --json`（4 high、1 moderate）与 `pnpm audit --prod --json`（0）。审计原始回包仅保存在本地临时目录，不随 PR 上传。

## 7. 完整软件与数据隔离

- E/G 盘不存在，L 盘经检查是 CloudFS 网盘，不用作 Rust 编译盘。
- 沿用该分支原有专用 `D:\TouchAI-build\dependency-upgrade-origin-main\target`，不清理其他 target，不新建另一套 Rust target。
- 外置 target 运行时必须设置 `TOUCHAI_APP_ROOT` 到本 worktree，避免错误解析数据/字体根目录。
- 不停止或覆盖安装版 TouchAI，不使用其 release 数据库。worktree 的 `data/` 不提交、不删除。
- 当前测试版使用 `TOUCHAI_E2E=1`，是完整桌面自动化模式：单实例、快捷键、MCP 自动连接等路径受到限制，不能算正常模式这些能力通过。

最终锁文件下执行 `pnpm --filter @touchai/desktop exec tauri build --debug --no-bundle` 成功，包含应用类型检查、生产前端及 Rust 完整程序构建。产物是 debug 可执行程序，**不是 release 安装包**：

`D:\TouchAI-build\dependency-upgrade-origin-main\target\debug\TouchAI.exe`

通过真实 WebView2 的 CDP 连接验证（页面为 `http://tauri.localhost/#/`，不是 Vite）：

- 通过原生 IPC 确认 DATA/ASSETS 均在当前 worktree，运行模式为 E2E；安装版仍保留运行。
- 主窗口输入框和设置窗口均可加载；七个设置导航页均有实际内容，MCP 空态及添加入口正常。未添加服务器、修改凭据或触发工具执行。
- 窗口尺寸下拉可打开；Esc 关闭后恢复焦点，原选择值没有变化。
- Tiptap 可输入 Unicode 文本、Shift+Enter 换行、追加第二行并清空；**这不是系统中文 IME 测试**，没有发送模型请求。
- 以上交互未捕获 pageerror；未把浏览器 fixture 的剪贴板 mock 算作系统剪贴板测试。

证据：`tauri-build-final.log`、`tauri-smoke-final.log`、`tauri-interactions.json`、`tauri-main.png`、`tauri-settings.png`。

正常模式的全局快捷键、托盘、通知等仍需在不与安装版冲突的条件下另行验收；当前不把自动化模式等同于这些能力已经通过。

## 8. 滚动条回归（本轮修复）

升级后的 File/Diff 渲染器使用了新的滚动容器：纵向滚动实际发生在 `.code-editor-container` / `.stream-diffs-shell`，而不是旧版主要覆盖的 `.code-block-content`。同时 File/Diff 内容位于 Shadow DOM，文档层 CSS 无法直接覆盖其 `[data-code]` 滚动条。未覆盖这两个边界时，WebView2 会显示带箭头的 Windows 原生滚动条。

已在当前升级依赖的前提下修复：

- light DOM 的 `.code-block-content`、`.code-editor-container`、`.stream-diffs-shell` 和流式阶段 `.code-pre-fallback` 统一使用 TouchAI 的 6px 滚动条、透明轨道、灰色圆角 thumb 和隐藏按钮；
- 通过 markstream 支持的 `unsafeCSS` 将同一套颜色、圆角、按钮规则注入 File/Diff Shadow DOM 的 `[data-code]`；保留渲染器需要的滚动 gutter，不改其滚动同步/布局；
- 新增 CSS contract test 和真实 Chromium 回归，覆盖 streaming → final、长代码滚动、滚到底、鼠标滚轮、折叠展开、File/Diff 双栏、CSS token 继承；
- 没有降级任何依赖，也没有扩大依赖升级范围。

本地回归证据：`.tmp/markdown-regression/scrollbar-regression.json`、`scrollbar-streaming.png`、`scrollbar-after.png`、`scrollbar-hover.png`；核心结果为 width/height 6px、thumb `rgba(156, 163, 175, 0.4)`、radius 3px、button hidden、streaming/final/diff 无 page error。

本轮新增验证：

- 定向 Vitest 3 个文件、32 个测试通过；新增覆盖前先观察到滚动条 contract 4 项失败，浏览器计算样式为 auto 宽度/透明 thumb，修复后通过。
- 测试类型检查、改动测试文件 ESLint、改动文件 Prettier 和 git diff --check 通过。
- 完整 Tauri debug/no-bundle 再次构建成功，并启动测试版；安装版进程保持运行。证据：tauri-build-scrollbars.log。
- 在真实 WebView2（tauri.localhost）中加载本次产物导出的真实 MarkdownContent/Vue 模块，以临时、不落库的长代码 fixture 验证：滚动条 6px、圆角 3px、按钮隐藏、可滚到底，鼠标拖动 thumb 后 scrollTop 从 0 增至约 685px；无 pageerror。测完已卸载 fixture 并恢复窗口尺寸，没有发模型请求或修改用户输入/会话。证据：tauri-scrollbar-regression.json、tauri-scrollbar-after.png。
- 此轮没有重跑全量 Vitest 或网络安全审计；第 5/6 节已记录的失败/风险不因本次定向测试通过而关闭。E2E 模式与正常模式的区别仍按第 7 节处理。

### 8.1 代码块关闭自动换行（2026-10-07）

按 maintainer 的新要求，代码块只在原文换行符处换行，超长行通过横向滚动阅读；正文段落仍正常自动换行。

- 在现有 `codeBlockMonacoOptions` 中显式设置 `wordWrap: 'off'` 和 `diffWordWrap: 'off'`，并使用上游导出的 `CodeBlockMonacoOptions` 类型约束配置。普通代码与 Diff、流式占位与最终 File/Diff 统一，不通过全局 CSS 禁止正文换行。
- 保留本节前述 TouchAI 自定义滚动条，不改字体、行高、背景或依赖版本。
- 新增默认消息/推理消息的流式到 final 配置回归，先确认两项失败，再完成修复；定向 Vitest 3 文件 34 测试通过。测试类型检查、改动文件 ESLint/Prettier、git diff --check 通过。
- 真实 Chromium 在 780px / 420px 视口下验证中英文长行、空格、tab 缩进、空行：原始 4 行仍为 4 行，final 行高均为 19px，流式与 final 可横向滚到末端，页面无横向溢出；逐帧检查 handoff 不回到 wrap。复制保留完整原文，折叠/展开后仍不换行，Diff 两栏不软换行，正文自动换行不受影响。
- 重新运行原有滚动条和交互回归：6px 自定义皮肤、120 行纵向滚动到底、多代码块隔离、复制/折叠/展开、重新挂载、HTML 作为纯代码文本均通过，无 pageerror。

证据位于 `.tmp/markdown-regression/`：`no-wrap-regression.json`、`no-wrap-narrow.png`、`extended-interactions.json`、`scrollbar-regression.json`。浏览器剪贴板为 mock，不当作系统剪贴板测试。

完整 Tauri debug/no-bundle 构建已通过，并已重启本 worktree 测试版，未停止安装版。在实际 WebView2 的临时、不落库 fixture 中验证 streaming / final / Diff：原始 4 行及空行、缩进均保留，行高为 19px，横向自定义滚动条为 6px、无箭头；拖动后 scrollLeft 增加约 1159px，无 pageerror。测试后卸载 fixture 并恢复窗口尺寸，未发送模型请求、修改用户输入或会话。证据：`tauri-build-no-wrap.log`、`tauri-no-wrap-regression.json`、`tauri-no-wrap-after.png`。当前仍使用第 7 节的 E2E 隔离模式，不将其当作正常模式快捷键/托盘等能力的验收；全量测试及安全审计遗留风险未因此关闭。

## 9. 可直接执行的人工验收表

详细用例已单独整理到同目录 `frontend-dependency-upgrade-manual-acceptance.md`：31 项用例，按 P0/P1/P2 分级，含操作步骤、预期结果、结果栏及 7 组可复制对话提示词（A～G）。不预填“通过”，不把尚未修复/未构建项目移交成已完成开发工作。

**本轮新增修复已进入当前完整桌面产物。** 第 5、7、8 节的生产构建/Tauri 运行证据与第 10 节源码修复均已合并到同一构建；当前 exe 文件时间为 2026-10-07 18:06:36（本机时间）。

## 10. 流式公式与代码收起调查（2026-10-07）

### 10.1 流式公式边界：源码修复，已整包构建

问题可稳定复现，不是“流式输出只能如此”：真实 `stream-markdown-parser@1.1.0` 在 `final:false` 的增量路径中，遇到跨分块的数学闭合标记，会重用错误的边界缓存，将后面的粗体标题当成 `math_block`。完整输出改用最终解析时恢复，解释了“输出中错、完成后正常”。

最小样本为行内代码 `$$` 说明、4 个粗体标题和对应数学块，字符边界 `[1, 5, 16, 46, 73, 115, 180]`：修复前在第 180 个字符，数学节点内容错误包含 `**示例3：泰勒展开**`。该失败由真实 parser 的组件测试捕获，不是 mock 返回预设节点。

修复位于 `MarkdownContent.vue`：仅当缓冲含数学块候选分隔符 `$$` 或 `\[` 时设置 `streamParse:false`，重新解析当前缓冲；其他输入保留 `auto` 快速路径。仍传递真实 `final` 状态，未完成节点仍可 loading，**不是等全部输出结束才显示，也没有删除 AST 节点或用 CSS 隐藏错误内容**。

回退是保守策略：代码里包含这些字符也会触发重解析；未做长历史实时流式性能保证，见人工 L01。只含行内公式/普通 shell 变量的输入不触发回退。没有修改依赖版本或降级。

边界：LaTeX 语法本身未输出完整时，仍可能短暂显示源码/占位，不能保证半个命令立刻排版；本次修复的是闭合公式错误吞掉后续标题/正文。

### 10.2 本轮验证

- 新增 `MarkdownContent-streaming.test.ts`，10 项：5 个解析策略场景，固定复现边界，逐字符及 19 种固定种子分块，括号/行内公式与 shell 变量，未完成公式 loading → 闭合，公式后代码/换行。展示组件为 stub，解析函数调用真实包；策略测试 spy 仍执行原函数。
- 定向 Vitest：4 个测试文件、45 项通过（包含原有 i18n/配置、运行时依赖、自定义滚动条回归）。应用与测试类型检查通过；本轮 Vue/测试 ESLint 通过；本轮修改文件 Prettier、`git diff --check` 通过。
- 真实 Chromium 当前源码 fixture：最小样本 8 个分块、4 个公式；原会话 431 个分块、8 个公式。未吞标题、已完成公式在 final 之前正常渲染，final 后公式内容不变；无 pageerror。截图人工复核了最小样本的 4 个标题和 4 个公式。
- 重跑长行不软换行及自定义滚动条 browser 回归通过，未因 parser 修复回退。
- `pnpm test:pr` 完整重跑通过：typecheck、lint（0 error / 20 个既有 warning）、Prettier、Rust fmt/check、Vitest（161 文件 / 1013 项）、Rust tests（161 passed / 1 ignored）、前端 coverage（Statements 54.97%、Branches 44.27%、Functions 52.63%、Lines 55.57%）及官网 build 均通过。官网仍有空 i18n collection warning。首次运行仅因 GitHub 下载 RTK 超时失败；重试成功。

证据位于 gitignored 的 `.tmp/markdown-regression/`：`math-fixed-browser.json`、`math-fixed-streaming-4.png`、`math-fixed-streaming-8.png`、`no-wrap-rerun.log`、`scrollbar-rerun.log`。临时目录含实际会话原文，不提交或上传。

### 10.3 代码块收起留白：未复现，未关闭

不能把正常复现结果当成用户问题不存在，也未盲目加全局 height/min-height 覆盖。

已验证：

1. 同一份原会话代码，在 Chromium、系统 Edge 和完整测试版 WebView2 中套消息 grid 容器：全部可收起。
2. 通过真实 UI 打开历史会话，在实际 ConversationPanel/AssistantMessage 内点击收起：代码块、node-content、node-slot 高度同步缩到约 45.58px；消息祖先没有保留原代码高度。随后已重新展开，无模型请求、无消息改写。
3. 完整测试软件内临时、不落库 fixture：普通/推理两种 variant，分别在 1 行、60 行时收起；继续追加到 80/160/240 行、关闭围栏、final、再展开。四种组合都只留下约 45.58px 工具栏，shell 高度 0，展开后恢复约 545.58px；无 pageerror。该项覆盖与当前代码一致的折叠路径，最终 exe 仍需由 maintainer 按 C01/C05 做真实输出中验收。

证据：`tauri-reported-collapse.json`、`tauri-real-conversation-collapse.json`、`tauri-real-conversation-collapse.png`、`tauri-streaming-collapse.json`。所有临时 overlay 均已卸载，窗口尺寸恢复，安装版进程未停止。

未覆盖真实模型请求中的现场时序、超过 320 节点的推理虚拟化等组合；没有宣称全部折叠路径通过。若现场再次出现，需保留包含语言、按钮和下方正文的截图及未刷新的窗口，以便读取留白容器真实高度。

### 10.4 当前构建产物

本轮已完成完整 Tauri debug/no-bundle 构建，产物位于 `D:\\TouchAI-build\\dependency-upgrade-origin-main\\target\\debug\\TouchAI.exe`，构建完成时间为 2026-10-07 18:06:36。该产物用于本地人工验收，不是 release 安装包；C01/C05 的真实模型流式时序仍保留为人工开放项。

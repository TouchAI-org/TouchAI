# 用 cua-driver 承接 computer use：接入方案（RFC #111 修订）

> 调研日期：2026-11-01
> 关联 issue：#111（RFC）、#101
> 结论：**不再自研原生截图与输入注入层，改为引入 cua-driver 作为执行后端**；二进制不走构建期内嵌，改为运行时从 PyPI 国内镜像异步下载单文件 `cua-driver.exe`，以 MCP stdio 方式挂到现有的 `core/mcp` 客户端上。

---

## 1. 为什么换掉原方案

RFC #111 原计划在原生层自建：屏幕捕获、坐标换算、输入注入、节流、敏感面拦截，再配一套 stepwise 审批循环。实测结论是这个"执行层"本身的工程量与风险都被低估了：

| 维度 | 自研（原 RFC） | cua-driver |
| --- | --- | --- |
| 元素定位 | 需要自己做 UIA/AX/AT-SPI 树遍历 | 已实现，且带 `element_token` 快照语义 |
| 动作投递 | 自己选 SendInput / UIA Invoke / WM_消息 | 已实现后台优先的动作阶梯 + 前台升级建议 |
| 校验 | 自己做 | 每个动作返回 `route` / `effect` / `escalation` |
| 平台 | 三平台各自一套 | Windows/macOS/Linux 同一份契约 |
| 浏览器 | 已有 CDP（`core/browser`） | 额外提供 CDP 工具，可与现有能力互补 |
| 风险 | 我们承担全部正确性 | 上游承担，我们只承担编排与审批 |

保留的部分：**审批、敏感面遮蔽、步骤可视化、会话内工具契约**——这些是 TouchAI 的产品差异，仍然自己做。

---

## 2. 实测事实（Windows 11 / cua-driver 0.38.0）

| 项目 | 实测值 |
| --- | --- |
| PyPI wheel（win_amd64） | 32,842,600 B（31.3 MB），sha256 `30e6fe57…` |
| 解包后 | `bin/cua-driver.exe` 36.9 MB、`bin/cua-driver-uia.exe` 24.3 MB、`cua_driver_sdk.dll` 29.1 MB |
| 只保留 `cua_driver_sdk.dll`（29.1 MB） | **进程内可用**：`caa_driver_abi.h` 的 15 个 C 函数即可跑完 6×7 全流程，不需要 exe、uia helper 或子进程 |
| 后台启动应用 | `launch_app` 返回 `active:false`，不抢焦点 |
| 无障碍树快照 | 54–120 ms（39 元素） |
| 树 + PNG 快照 | 260–440 ms |
| 元素点击 | 4–19 ms/次，`route=ACCESSIBILITY`，`effect=unverifiable`（需二次快照验证） |
| 国产镜像下载 | 清华 4.5 MB/s（pip）/ 11.2 MB/s（直链），阿里云 5.06 MB/s；GitHub 直连 131 KB/s–6 MB/s 波动，公共 gh 代理 37–86 KB/s 不可用 |
| 权限模型 | `standard` 模式拒绝跨运行时终止进程；`stale_element_token` 会明确拒绝 |
| 许可证 | driver MIT，与本仓库 GPL-3.0 兼容；`cua-perception` 扩展为 AGPL-3.0，**不引入** |
| 遥测 | **默认开启**，需显式 `cua-driver telemetry disable` |

镜像路径已验证三家（清华 / 阿里云 / pypi.org）对同一 `/packages/...whl` 路径均返回 200，可只存相对路径 + 多个 base。

**镜像对无 `User-Agent` 的请求返回 403**（实测）：同一 URL，默认 .NET 客户端 403，带 UA 后 206。Rust 侧必须显式设置 UA，否则会静默退到 pypi.org（最慢的源）。

---

## 3. 目标架构

```text
AgentService 工具调用
    -> computerUse 工具面（TS，审批 + 遮蔽 + 展示）        ← 新增，复用 browser 工具的模式
        -> Tauri command（computer_use_*，可取消）
            -> computer_use::abi（Rust 薄封装，libloading）
                -> cua_driver_sdk.dll（进程内，C ABI 1.1）
                    -> 系统无障碍 + 输入注入
```

三层职责：

1. **Provisioning（Rust，新）**：下载、校验、安装、版本切换、健康检查。
2. **Runtime（复用 `core/mcp`）**：把 `cua-driver mcp` 注册成一个内置 MCP server，工具按白名单暴露。
3. **Policy（TS，新）**：审批、敏感字段遮蔽、动作预演、步骤历史。

### 关键决策：进程内 C ABI（内置），而不是 MCP 子进程

原先倾向 MCP，因为能直接复用 `core/mcp`。C ABI 表面核实后改判：**内置更划算**。

- `rust/include/cua_driver_abi.h` 只有 **15 个 C 函数**（create / destroy / is_available / metadata / list_tools / invoke / session_create / session_invoke / session_destroy / operation_cancel / operation_release / shutdown / abi_version / is_compatible / buffer_free），ABI 1.1.0 带版本协商，结果统一是 JSON 缓冲。
- 不发布 Rust crate（crates.io 无 `cua-driver`），所以"SDK"对 Rust 而言就是这份 C ABI + 自己写的薄封装（`libloading` + `extern "C"`），不需要 bindgen。
- 实测：用 60 行封装在进程内跑通完整链路（见 §9.1），不需要子进程、socket 或 MCP 握手，取消由 `operation_cancel` 直接完成。
- 代价：多下 `cua_driver_sdk.dll`（29.1 MB）；Windows 上进程内运行时不需要 `cua-driver.exe`。

MCP 仍保留为逃生通道（排障、外部 agent 接入），但主路径是内置 ABI。

---

## 4. 分发与异步下载

### 4.1 清单（编译进二进制，不含大文件）

```json
{
  "version": "0.38.0",
  "targets": {
    "x86_64-pc-windows-msvc": {
      "filename": "cua_driver-0.38.0-py3-none-win_amd64.whl",
      "package_path": "/packages/8c/1c/82b8…/cua_driver-0.38.0-py3-none-win_amd64.whl",
      "sha256": "30e6fe57…",
      "size": 32842600,
      "entry": "cua_driver/bin/cua-driver.exe",
      "binary_sha256": "<安装后二进制>"
    }
  },
  "mirrors": [
    "https://pypi.tuna.tsinghua.edu.cn",
    "https://mirrors.aliyun.com/pypi",
    "https://pypi.org"
  ]
}
```

`binary_sha256` 用于二次安装时的快速命中判断，避免每次重算 32 MB。

### 4.2 下载

- 按 `mirrors` 顺序尝试，单源连续失败 2 次或 8 s 无字节推进即切换下一源。
- HTTP Range 断点续传，落盘到 `cache/cua-driver/<version>/download.whl.part`。
- 校验 sha256 后才原子 rename 为正式文件；校验失败删除重下（最多 2 轮）。
- 全程 tokio 异步，不阻塞 UI；进度通过 Tauri event 上报（`computer-use://provision`）。
- 用户可显式关闭自动下载（离线/内网场景），此时功能降级并给出可点击的"手动安装"入口。

### 4.3 安装布局

```text
<app data>/computer-use/<version>/cua-driver.exe
<app data>/computer-use/<version>/install.json     # version + sha256 + installed_at
```

- 只用 `wheel::entry` 指定的那一个 exe，解包后其余文件丢弃（省 53 MB）。
- 新版本装完后写 `current` 指针（JSON，原子 rename），旧版本保留 1 份用于回滚。
- 安装前先跑 `cua-driver --version` 与 `doctor --json` 做健康检查，失败则不切换指针。

### 4.4 体积账

| 方案 | 安装包增量 | 首启下载 |
| --- | --- | --- |
| 构建期内嵌（rtk 模式） | +37 MB（每平台） | 0 |
| 运行时下载单 exe | 0 | 31.3 MB（清华 ≈ 7 s） |

---

## 5. 工具面与审批

v1 只暴露 8 个工具，映射到 cua-driver 的原生工具，其余一律不暴露：

| TouchAI 工具 | cua-driver 工具 | 审批 |
| --- | --- | --- |
| `computer_observe` | `get_window_state` / `get_desktop_state` | 否（只读） |
| `computer_list_targets` | `list_apps` / `list_windows` | 否（只读） |
| `computer_click` | `click` / `double_click` / `right_click` | 是 |
| `computer_type` | `type_text` | 是，且回显待输入文本摘要 |
| `computer_key` | `press_key` / `hotkey` | 是 |
| `computer_scroll` | `scroll` | 是 |
| `computer_launch` | `launch_app` | 是 |
| `computer_verify` | `get_window_state`（同 session 二次快照） | 否 |

规则：

- 拒绝 `run_script` / `run_steps` / `clipboard_*` / `browser_set_input_files` / `download` 等复合或高权限工具进入 v1。
- 每次 mutating 调用必须带 `delivery_mode:"background"`；驱动返回 `escalation:foreground` 时，**由用户单独批准**后才允许前台重试。
- `effect != confirmed` 时工具结果标注"未确认"，并由 `computer_verify` 复验，不复验不进入下一步。
- 复用 `tools/browser/redaction.ts` 的敏感面判定：命中密码框、支付、身份信息时强制二次确认并遮蔽截图片段。
- 截图只进当前会话上下文，不落盘到 `data/`，不进日志。

---

## 6. 与现有模块的关系

| 现有模块 | 复用方式 |
| --- | --- |
| `core/mcp`（rmcp 客户端） | 直接复用；新增"内置 server"注册路径，避免污染用户自定义 MCP 列表 |
| `core/browser` + `tools/browser` | 审批、遮蔽、动作展示的既有模式；浏览器场景仍优先走 CDP，桌面场景走 cua-driver |
| `core/system/paths.rs` | 新增 `AppDirectory::ComputerUse` 条目 |
| `core/system/bundled.rs` | 只作参考，不修改：本方案是运行时下载，不是构建期内嵌 |
| `built_in_tools/registry.rs` | 参考其取消语义，给 `computer_use` 动作做可取消执行 |

---

## 7. 分阶段落地（一 PR 一事）

| 阶段 | 内容 | 验收 |
| --- | --- | --- |
| P1 provisioning | 清单 + 镜像选择 + 断点续传 + 校验 + 安装/回滚 + 健康检查 | 单测覆盖源切换、校验失败、断点续传、原子切换；真机从清华源装成功 |
| P2 runtime | 内置 ABI 运行时（dlopen + 15 函数封装）、单例生命周期、可取消调用 | 能 list_windows / get_window_state；取消生效；dll 缺失时降级不崩 |
| P3 policy | 审批流、遮蔽、`effect` 复验、步骤历史与截图渲染 | e2e：计算器 6×7 全流程可审批、可取消、可复验 |
| P4 硬化 | 遥测关闭、签名校验、代理设置、离线包导入、旧版本清理 | 内网/离线可安装；安全评审通过 |

P1 不触碰 AgentService 与工具执行，可先行合入。

---

## 8. 风险与开放问题

1. **PyPI 作为分发渠道不是官方承诺**：上游随时可能调整 wheel 结构。缓解：清单里同时保留 GitHub Release 的 `windows-x86_64.zip` 作为第二来源，二者都只认 sha256。
2. **遥测默认开启**：必须在首次启动时写入 `telemetry disable`，否则违背本地优先承诺。
3. **GPL 与分发**：MIT 组件并入 GPL-3.0 产物合规；但需在 `THIRD_PARTY_NOTICES` 中登记 cua-driver 与其许可证。
4. **macOS**：TCC 权限绑定签名 app 身份，运行时下载的 app bundle 会带 quarantine 属性，需要去 xattr + 独立签名。**v1 建议仅 Windows**，mac 单独立项。
5. **提权目标**：`standard` 模式对高完整性窗口拒绝注入，UI 需如实提示"该窗口需要以相同权限运行 TouchAI"。

## 9. 设置页与对话内控制

### 9.1 “电脑操作”设置页

驱动自带的控制面（`cua-driver config show` 实测键）直接映射成页面字段：

| 分组 | 字段 | 来源 |
| --- | --- | --- |
| 驱动状态 | 版本、ABI、安装路径、健康检查、当前通道 | `metadata` / `doctor` / `channel status` |
| 下载与升级 | 下载进度、镜像源、检查更新、切换 stable/nightly、回滚上一版、离线包导入 | 自建 provisioning + `check-update` / `channel` |
| 行为 | agent 光标显示、光标样式与动效、徽标详细度、截图最大边（默认 1568）、capture_mode | `agent_cursor.enabled`、`cursor.motion.*`、`cursor.badges`、`max_image_dimension`、`capture_mode` |
| 权限 | 审批粒度（每次 / 本窗口本会话）、允许的应用范围、敏感面拦截、是否允许前台升级 | 自建策略层 |
| 隐私 | 遥测开关、身份重置、轨迹录制、一键撤销所有会话 | `telemetry enable/disable/reset-id`、`recording`、`revoke --all` |
| 统计 | 操作次数、成功率、平均单步耗时、被拒次数、前台升级次数 | 本地聚合，不上传 |

### 9.2 对话内控制（参考 Codex / LobeHub）

两家的共同边界：

- **Codex**：审批是“动作卡片 + 单次批准”，权限档位（只读 / 自动 / 完全）在输入区可见，越权时降级为拒绝而不是静默放行。
- **LobeHub**：工具调用是消息流里的可视节点，可展开参数、可中断，产物集中到独立面板。

TouchAI 的做法：

1. 输入区放一个“本会话允许电脑操作”开关（不做常驻状态条），停止按钮与动作卡片同行。
2. 每个动作在消息流里生成一张卡片：目标（应用/窗口）、动作、文本预览、`effect` 结果；未确认时明确标注“未验证”，并自动跟进一次校验。
3. 审批是单次令牌：拒绝 = 不产生任何输入事件；批准只对这一次调用生效。
4. 会话结束、关闭开关、或用户点停止 → `revoke` 该会话，element_token 立即失效。
5. 前台升级（`escalation:foreground`）单独一条审批，不与普通动作合并。

## 10. P2 进展（分支 `111-cua-driver`）

| 文件 | 内容 | 验证 |
| --- | --- | --- |
| `abi.rs` | C ABI 安全封装：加载、create、metadata、可取消 invoke、cancel、destroy | 编译过；真机 E2E 过 |
| `driver.rs` | 单例运行时：确保安装 → 加载 → 状态/调用/取消/关闭 | 编译过 |
| `manifest.rs` / `provision.rs` / `http.rs` | 下载、校验、安装（已把入口从 exe 改为 dll） | 13 个测试过 |

E2E（真机 Windows 11，通过 `abi.rs` 而不是一次性探针）：

```
abi 1.1.0, compatible(1,1)=true
metadata = {driver_version:"0.38.0", embedded:true, ...}
元素 39，后台点击 清除/六/乘以/七/等于 5-12 ms/次
after = 显示为 42, total 404 ms
E2E PASS
```

未完成：Tauri command 与设置页。这两块必须跟完整应用一起编译才有意义，当前磁盘（C: < 0.5 GB）做不到，不能提交未验证的胶水代码。

### P1 证据（保留）

已落地 `apps/desktop/src-tauri/src/core/computer_use/`：

| 文件 | 内容 |
| --- | --- |
| `manifest.rs` | 固定版本/摘要/镜像清单，target 映射，URL 组装 |
| `provision.rs` | 镜像回退、Range 续传、sha256 与体积校验、从 wheel 提取单个 exe、`install.json` 与 `current.json` 原子写、已安装快速命中 |
| `http.rs` | reqwest 实现，显式 UA + Range + 服务器忽略 Range 时重启文件 |
| `provision/tests.rs` | 7 个行为测试 |

证据：把这四个文件抽成最小 crate 编译并运行，**13 个测试全部通过**；`rustfmt --check` 通过。测试中真实抓到一个平台缺陷并已修复：Windows 上以 `append(true)` 打开的文件无法 `set_len(0)`（os error 5），改为 `read+write` 后按需 seek 或截断。

未运行：仓库整体的 `pnpm test:pr` / `cargo test`。原因：本机系统盘可用空间不足（C: < 1 GB），Tauri 依赖树无法完整编译；合入前需在有空间的机器上重跑。

端到端脚本 `scripts/ci/prove-cua-driver-provision.ps1` 已在真机跑通：校验通过、wheel 提取出 exe、`cua-driver --version` 输出 0.38.0。

**内置 ABI 端到端验证**（`scripts/ci/cua-abi-e2e.rs`，真机 Windows 11）：加载 `cua_driver_sdk.dll` → ABI 1.1.0 → 创建运行时 → `list_windows` 定位计算器 → 无障碍快照 39 元素 → 后台点击 `清除/六/乘以/七/等于`（7–18 ms/次，`route=accessibility`）→ 二次快照读回 `显示为 42`。全程 652 ms，无子进程、无 socket、无 MCP 握手。

## 12. 完成情况与已知缺口

已完成并验证：

| 层 | 文件 | 证据 |
| --- | --- | --- |
| 引擎接入 | `core/computer_use/{abi,driver,manifest,provision,http}.rs` | 13 个单测通过；真机 E2E 42 命中 |
| 原生命令 | `commands/computer_use.rs` | `cargo check` 通过 |
| 前端桥/服务 | `NativeService/computerUse.ts`、`ComputerUseService` | 10 个单测通过 |
| 设置页 | `SettingsView/components/ComputerUse` + 导航 + 图标 | 六组：驱动/行为/权限/隐私/统计 |
| 模型工具 | `tools/computerUse`（action 枚举 + 单次审批） | 全量 vitest 5415 用例通过 |
| 种子 | `seed.sql` 新增 `computer_use`（enabled=0, risk=high） | — |
| 生命周期 | `computer_use_check_update` / `computer_use_remove` + 设置页两个按钮 | 检查更新走 PEP 503 索引；移除会先 shutdown 再删目录 |
| 平台 | 清单补齐 Windows x64/arm64、Linux x64/arm64、macOS universal（均为进程内 `.dll/.so/.dylib`） | arm64-windows 未发布，`is_publishable` 会拒下并给明确错误 |

已知缺口（下一步）：

1. macOS 实机未验证：TCC 授权在自签更新后是否保持、agent 光标浮层不可用的实际体验。
2. `pnpm test:pr` 的 Rust 覆盖率门禁未跑（需 `cargo-llvm-cov` 与 ≥ 5GB 空余磁盘）。
3. `press_key` 的 `modifiers` 已按驱动 schema 透传，但未在真机验证组合键。

已完成追加：“本窗口本会话放行”已生效（`ComputerUseService` 内存白名单 + 切换回“每次动作”时清空，退出应用自动失效）。

代码审计后的修正：前台升级不再能绕过审批（原先 `return null` 等于免审）；`allowForeground` 改为单一数据源；卡片改用语义 token（`border-border-subtle`/`bg-canvas`/`text-text-*`）并删除自定义样式；`structuredPayload` 改为类型化；卡片改读结构化载荷而非正则抠字符串；`type`/`scroll` 参数名按 `describe` 实测对齐。

已接通：截图最大边（`set_config.max_image_dimension`）、操作光标（`set_agent_cursor_enabled`）、轨迹录制（`start_recording`/`stop_recording` 写入应用 cache）、对话内专用动作卡片（`ComputerUseToolCallItem.vue`，按 `builtin__computer_use` 分发）。

已完成追加：“本窗口本会话放行”已生效（`ComputerUseService` 内存白名单 + 切换回“每次动作”时清空，退出应用自动失效）。

## 13. 验证清单

- [ ] 清华/阿里云/官方三源切换与失败回退
- [ ] sha256 校验失败后重下并最终报错
- [ ] 断点续传（kill 进程后恢复）
- [ ] 安装目录原子切换与回滚
- [ ] 无网络时降级不崩，且能导入离线包
- [ ] `cua_driver_sdk.dll` 加载失败（ABI 不兼容）时降级不崩
- [ ] 审批拒绝时不产生任何输入事件
- [ ] DPI 缩放 100%/125%/150% 与多显示器坐标一致

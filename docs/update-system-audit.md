# 安装、发布与更新链路梳理

本轮工作统一在 PR #776，不拆成多个工作树或并行的更新系统。
关联问题：#766、#767、#768、#769、#771、#772、#773、#777。

## 链路与职责

1. `release-please.yml` 管理 Stable；`release.yml` 管理 Beta/Nightly。
2. `prepare-release-notes.mjs` 选择比较基线、读取已审核的多语言内容，输出兼容 Markdown、
   多语言 JSON 和 GitHub Release 正文。
3. `velopack-build.yml` 构建 Windows MSI/Velopack 包、macOS 和 Linux 安装包。
   Velopack 的历史包只用于差量生成，不混入本版本的公开发布清单。
4. 聚合作业筛出本版本产物，按打包版本生成源码依赖 SBOM、流式 SHA-256 清单及 Sigstore
   来源证明，再上传 GitHub Release。产物证明失败不会被当作可忽略警告。
5. Cloudflare R2 先上传二进制，成功后才上传通道 feed；最后清理已归档的旧文件。
   Worker 保留既有缓存/GitHub 归档回退、Range/HEAD 语义和来源限制。
6. 原生更新层读取 feed，Velopack 决定版本、差量策略并负责最终包校验及安装。
   HTTP 传输使用现有 reqwest/sha2 依赖，在已有 partial 路径上实现受约束的续传。
7. `AppUpdateService` 管理设置、检查节奏、失败重试和跨窗口检查结果；设置页、强制更新
   门禁与通知通过同一份类型契约、语言选择规则读取数据。

## 已落地的改进

| 用户遇到的缺口 | 本轮处理 |
| --- | --- |
| 新装 Beta/Nightly 却默认检查 Stable | 从应用版本推导初始通道；已保存的选择优先 |
| 切换通道可能降级，数据库却已迁移 | 原生明确禁止降级；保留数字化的 Beta 版本比较 |
| Beta 日志可能与 Stable/Nightly 比较 | 生成日志时显式传上一个已发布且版本更低的 Beta 标签；首个 Beta 才回退 Stable |
| 日志只有一种语言 | 发布端支持已审核的中英文内容；feed 与 IPC 保留语言映射，UI 即时切换并回退英语 |
| 发布重跑使双语重复，或被打包作业覆盖 | 仅准备作业写 Release 正文；识别生成的英文区段，保证重跑不重复嵌套翻译 |
| 下载或安装失败后只能跳外部网页 | 保留可重试的候选版本；安装重试复用已下载的包 |
| 关闭下载对话框却标成“取消” | 改成“后台继续”，并允许通过“查看下载”重新打开进度，不重复检查或下载 |
| 下载中断后从零开始 | 有 SHA-256 元数据时续传；验证精确 Range、长度和续传后的摘要，不信任任意追加响应 |
| CDN 忽略 Range、拒绝 Range 或断点内容损坏 | 安全地从头获取；无 SHA-256 的旧 feed 保持完整下载，不冒险复用断点 |
| 网络请求可能无限等待 | 显式连接和读写操作超时；使用有上限的流式缓冲区及稀疏进度事件 |
| 离线检查打扰用户，恢复后仍等很久 | 自动检查离线时安静跳过；在线失败按 1/2/4/8/16/32/60 分钟退避，成功恢复一小时节奏 |
| 操作系统错误地报告“离线” | 手动检查仍尝试真实原生请求，避免把联网提示当成不可用的绝对判断 |
| 新 feed 先出现，文件还未上传 | 发布顺序显式拆成先二进制、后 feed，前一步失败不会进入后一步 |
| R2 临时失败跳过了可用归档 | 版本化二进制继续尝试既有缓存和 GitHub 回退；feed 错误不伪装成成功 |
| 更新后找不到本版本日志 | 已取得匹配本版本的日志时，提供独立阅读入口，不触发检查、安装或降级 |
| 下载前不知道包大小 | 显示声明的完整包体积，不把它冒充为差量实际流量或剩余时间 |
| 用户只能靠文件名相信下载来源 | 提供最终产物校验和、keyless 构建来源证明、可下载证明包及源码依赖 SBOM |

## 安全与兼容性边界

- 没有数据库、迁移、持久化 JSON 设置形状、CSP、工具权限或遥测内容变更。
- feed 仍为 `SchemaVersion: 1`，保留 `releaseNotes` 和 Velopack `NotesMarkdown`。
  新客户端可以读旧 feed；旧客户端继续读兼容内容。
- 语言选择优先当前语言，其次英语，最后是**匹配版本**的旧日志；已下载版本与最新版本
  不同时，不把别的版本日志展示成它的更新说明。
- 续传不绕过 Velopack 的最终校验、安装路径或禁止降级配置，不创建第二份下载状态数据库。
  服务器持续返回错误时仍会明确失败，而不是把缺损文件标成“已下载”。
- 自动检查的失败计数仅存在于内存，有上限；保持 08:00 至午夜的原有检查时段。
  重新调度和窗口退出会移除本轮创建的定时器与网络监听。
- “后台继续”不是取消 API，也不是强制安装。安装仍由用户确认。
- 当前版本日志入口使用已经取得的匹配 feed，不新增已安装版本历史存储或启动弹窗。
  若通道已推进到其他版本，可从 GitHub Release 查看更早日志。

## 为什么选择这些实现

- 保留 Velopack 的安装/差量/校验机制，而不重写更新器。已安装的
  `velopack 1.3.39-g8d2844f` 的 HTTP 下载实现使用 `File::create` 且默认无超时，
  无法完成断点续传。因此仅替换 HTTP 传输，并抽成共享的 `core/download.rs`：更新包与字体
  CDN 共用同一套 Range、长度、SHA-256、重试和进度策略，底层仍使用已有 reqwest 与 sha2，
  不自行实现 TLS 或摘要算法。
- 发布脚本复用已有版本解析和通道校验工具。元数据准备作业不需要为比较几个标签而安装整套
  前端依赖；前端版本比较直接使用已有 `semver` 包的 `valid` 与 `gt`，不再维护手写正则比较器。
- 使用 Node 内建流和 crypto 生成跨平台清单，而非新增依赖或将大文件整体读入内存。
- 使用固定提交的 GitHub `actions/attest` 与 Anchore SBOM action，并固定 Syft 版本。
  `attest-build-provenance` 上游已建议新集成使用 `actions/attest`，所以没有添加一层旧包装。
- 不依赖付费翻译、不把用户内容送到翻译服务，也不把未经审校的自动翻译当成发布事实。

## 不应误认为已经解决的事情

- 免费 keyless 来源证明不等于 Windows Authenticode 或 macOS Developer ID/公证。
  SignPath Foundation 需维护者申请；Apple 的相应开发者资格通常收费。
- SBOM 是发布源码的依赖清单，不等于完整安装包内所有系统组件的清单，也不是漏洞扫描结果。
- 不做数据库自动回滚，也不通过旧版本覆盖来“撤销”已安装更新。出现问题应发布**更高版本**修复。
- 当前分批验证仍通过 Beta/Nightly 和受保护的 Stable 发布环境完成；本轮没有新建百分比灰度、
  远程撤销已下载包或新的发布控制后台。若需要这些机制，应先明确离线安装、撤销时效和强制更新
  策略的兼容性，不能把切换到旧 feed 当作安全回滚。
- CI 配置和静态验证不等于完成了一次真实签名发布。本轮不发 tag、不部署 Worker/R2、不签署
  服务条款，也不对生产数据进行迁移。
- 本机组件截图和单元测试不能替代 Windows 安装版升级、macOS Gatekeeper、Linux 包管理器
  以及原生 release 构建的性能验收。相关未运行项在 PR 中逐项列出。

## 维护入口与参考

- [中英文日志编写规范](../apps/desktop/release-notes/README.md)
- [安装与更新包验证](release-verification.zh-CN.md) / [English](release-verification.md)
- [GitHub release notes API](https://docs.github.com/en/rest/releases/releases#generate-release-notes-content-for-a-release)
- [Velopack 文档](https://docs.velopack.io/)
- [GitHub artifact attestations](https://docs.github.com/en/actions/security-guides/using-artifact-attestations-to-establish-provenance-for-builds)
- [GitHub attest action](https://github.com/actions/attest)
- [Anchore SBOM action](https://github.com/anchore/sbom-action)

验收以真实行为为准：先记录 Given/When/Then，再运行失败用例，最后修复对应层。
PR 保存中英文组件证据、定向/全量检查命令及结果；发布前仍需在对应原生平台确认升级和性能预算。

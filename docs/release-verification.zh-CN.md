# 安装与更新包验证

[English](release-verification.md)

从 [TouchAI Releases](https://github.com/TouchAI-org/TouchAI/releases) 或官方更新服务
下载符合系统和架构的安装包。Windows 使用 MSI/Velopack；macOS 使用 DMG；Linux 提供
AppImage、DEB 和 RPM。开发构建不等于安装版，不支持应用内安装时请使用对应平台的安装包。

一般使用 Stable；全新 Beta/Nightly 安装默认跟随各自通道，已保存的选择优先。
**切换通道不会授权应用内降级**：如果 Stable 比已安装的 Beta 旧，请等待 Stable 追上。
数据库可能已迁移，不要用旧版本覆盖安装。手动替换前使用现有备份/导出功能保护数据。

## 先验证来源，再比较校验和

新流水线发布的版本附带 `SHA256SUMS`、`TouchAI-<版本>.source.spdx.json` 和
`provenance.sigstore.json`，旧版本不会自动补发。

安装新版 [GitHub CLI](https://cli.github.com/)，对**实际下载的安装包**运行以下命令。
将示例中的文件名替换为该版本的真实文件名：

```sh
gh attestation verify './TouchAI-<版本>-windows.msi' --repo TouchAI-org/TouchAI --signer-workflow TouchAI-org/TouchAI/.github/workflows/velopack-build.yml
```

检查验证结果中的源码提交、分支/标签是否属于目标发布版本。成功只证明该仓库的工作流
为这些字节出具了证明，不代表代码没有缺陷。不要因为文件名相同就信任其他仓库或工作流。

可加 `--bundle ./provenance.sigstore.json` 使用随包发布的证明，避免重新获取证明本身。
全新 CLI 仍可能需要联网获取 Sigstore 信任根；完全离线环境应提前准备信任根，不能把
“有离线证明文件”误解为“首次验证必定不联网”。

将上述命令的安装包路径换为 `./SHA256SUMS`，也可验证清单本身的来源。
然后计算安装包摘要，并与**同一版本**清单中该文件名的摘要逐字比较：

```powershell
# Windows PowerShell
Get-FileHash -Algorithm SHA256 -LiteralPath '.\TouchAI-<版本>-windows.msi'
```

```sh
# macOS
shasum -a 256 './TouchAI-<版本>-macos.dmg'
# Linux
sha256sum './TouchAI-<版本>-linux.AppImage'
```

Linux 下载全部清单文件后可运行 `sha256sum --check SHA256SUMS` 批量验证。
清单覆盖本次版本的安装包/更新包、更新日志和源码依赖 SBOM，不包含清单自身、证明包，
也不混入为了生成差量包而下载的旧版本。摘要不一致时停止安装，从官方来源重新下载。
**SHA-256 校验和本身不证明发布者身份。**

## 免费方案的能力边界

- GitHub Artifact Attestations 使用 OIDC 和 Sigstore 短期证书，无需保存长期签名密钥；
  当前免费 GitHub 方案中的公开仓库可以使用。
- 这不是 Windows Authenticode，也不是 macOS Developer ID/公证，因此 SmartScreen
  和 Gatekeeper 仍可能提示。不要为了安装而全局关闭系统安全检查。
- [SignPath Foundation](https://signpath.org/) 为符合条件的开源项目提供免费代码签名，
  需要维护者申请并接受条款；本次修改没有代为申请，也没有声称已取得证书。
- Apple Developer ID 与公证通常需要付费开发者计划；ad-hoc 签名不能替代发布者身份。
- SPDX SBOM 由固定版本的 Anchore Syft 扫描发布源码及可识别的 lockfile 生成，明确是
  **源码依赖清单**，不是漏洞扫描，也不保证列出所有打包的系统库、WebView 或下载的运行时。

## 发布者须知

流水线先构建并筛出本版本文件，再生成 SBOM、流式 SHA-256 校验和、来源证明，最后上传。
证明步骤失败会阻止本次上传和部署，不会静默回退成“签名成功”。证明文件发布在 GitHub
Release，现有 CDN 仍分发安装包和更新 feed；签名权限只授予证明作业及其可复用工作流调用方。

多语言内容的编写和校验见[更新日志规范](../apps/desktop/release-notes/README.md)。
应用内切换语言立即选择相应日志；缺少翻译时回退英语，不会把用户内容发给在线翻译服务。

更多来源与验证选项见[英文文档](release-verification.md)。

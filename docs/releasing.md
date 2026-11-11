# 发版流程

面向维护者和 Agent。发布只通过 GitHub Actions；不要手工打 tag、创建 Release、上传安装包或修改 feed。

## 通道

| 通道 | 版本 | 触发方式 | 更新日志 |
| --- | --- | --- | --- |
| Stable | `X.Y.Z` | 合并 release-please 发布 PR | `CHANGELOG.md`，可用本地化 JSON 覆盖 |
| Beta | `X.Y.Z-beta.N` | 在 `main` 手动触发 `release.yml` | 本地化 JSON，或 GitHub 生成 |
| Nightly | 自动生成或 `X.Y.Z-nightly...` | 定时任务，或手动触发 | 本地化 JSON（仅精确版本），或 GitHub 生成 |

只有从 `main` 触发的 Beta/Nightly 才部署生产 feed。

## Agent 授权

用户提出发版时确认一次：通道、版本（Nightly 可省略）、目标提交、是否带中文日志。确认后 Agent 可以连续完成日志准备、合并发布 PR、触发工作流、必要的环境确认和验证，不再逐项询问。只有目标提交、版本或日志范围发生变化时才重新确认。

## 发版前

```bash
git status --short --branch
git fetch origin
git rev-parse origin/main
```

- 工作区干净，Beta/Nightly 从最新 `main` 触发。
- 版本高于当前同通道版本；不允许降级。
- 发布日志已经人工审核，必需检查已经通过。

## 更新日志风格

参考 [Magpie Releases](https://github.com/Blinue/Magpie/releases)：写成用户能读懂的发布说明，不要贴 commit 清单。

- 开头用一句话说明这版最重要的变化。
- 按 `New Features` / `Fixes` / `Other Changes` 分组；中文对应“新功能 / 修复 / 其他变更”。小版本可以只用一个编号列表。
- 用编号列表，按影响排序；每条写用户能感知的结果，并尽量带 `#issue` 或 `#PR`。
- 不写 commit hash、内部文件名、纯重构、测试或 CI 细节，除非它们直接影响用户。
- 英文和中文保持相同结构；中文可以意译，不做机器翻译。缺少中文时只发英文。
- 可在末尾感谢重要贡献者。

需要定制日志时，在 `apps/desktop/release-notes/<version>.json` 写入经审核的 `en-US` 和 `zh-CN`。完整格式见 [`release-notes/README.md`](../apps/desktop/release-notes/README.md)。

Stable 默认使用 release-please 的 `CHANGELOG.md`；它适合作为技术回退，不保证符合上面的风格。需要面向用户的正式文案时，应在合并发布 PR 前加入 JSON。

## Stable

1. 找到并检查 release-please 发布 PR：

```bash
gh pr list --repo TouchAI-org/TouchAI --state open --search 'release-please' \
  --json number,title,url
gh pr checks <number> --repo TouchAI-org/TouchAI
```

2. 需要中文日志时，在同一发布 PR 中加入 `apps/desktop/release-notes/<version>.json`，然后推回该 PR 并重新等待检查。

3. 合并发布 PR：

```bash
gh pr merge <number> --repo TouchAI-org/TouchAI --squash
```

4. 跟踪自动发布：

```bash
gh run list --repo TouchAI-org/TouchAI --workflow release-please.yml --branch main --limit 3
gh run watch <run-id> --repo TouchAI-org/TouchAI --exit-status
```

合并后再补当前版本的中文日志已经来不及；应用内 feed 使用发布时生成的内容。

## Beta

1. 确保 `apps/desktop/release-notes/<version>.json` 已经在 `main` 上；不需要中文日志时可以跳过。
2. 触发精确版本：

```bash
gh workflow run release.yml \
  --repo TouchAI-org/TouchAI \
  --ref main \
  -f channel=beta \
  -f version=<version>
```

3. 跟踪运行并等待必要的环境确认：

```bash
gh run list --repo TouchAI-org/TouchAI --workflow release.yml \
  --event workflow_dispatch --branch main --limit 3
gh run watch <run-id> --repo TouchAI-org/TouchAI --exit-status
```

## Nightly

默认由每日 18:00 UTC 的定时任务发布，不需要 Agent 操作。手动补发：

```bash
gh workflow run release.yml --repo TouchAI-org/TouchAI --ref main -f channel=nightly
```

自动生成的 Nightly 无法提前知道版本号，因此通常只能使用 GitHub 生成日志。需要中文日志时，指定完整版本并先合入对应 JSON：

```bash
gh workflow run release.yml --repo TouchAI-org/TouchAI --ref main \
  -f channel=nightly -f version=<version>
```

## 发布后验证

```bash
gh release view v<version> --repo TouchAI-org/TouchAI \
  --json tagName,isDraft,isPrerelease,url,assets
```

确认 GitHub Release、安装包、`SHA256SUMS`、`provenance.sigstore.json` 和对应语言日志都存在。再检查生产 feed：

```bash
node -e 'fetch(process.argv[1]).then(r => r.json()).then(f =>
  console.log(JSON.stringify(f.Latest, null, 2)))' \
  https://updates.touch-ai.org/touchai-app/v1/releases.stable.json
```

Beta/Nightly 分别换成 `releases.beta.json`、`releases.nightly.json`。签名验证见 [`release-verification.md`](release-verification.md)。

## 失败处理

| 情况 | 处理 |
| --- | --- |
| 检查或构建失败 | 同一提交和版本重跑失败作业；不要先改版本号 |
| GitHub Release 已建但 feed 部署失败 | 重跑部署作业；不要手工写 feed |
| 已发布版本有严重 bug | 发布更高版本修复；不要回退 feed 或降级 |
| 用户已经看到错误日志 | 修改 GitHub Release 页面只修复页面；应用内发更高版本 |
| 误合并 Stable 发布 PR | 停止后续操作并通知维护者；不要删 tag 或手工回退 feed |

发布完成后报告通道、版本、提交、工作流链接、Release 链接、feed 版本和未验证项。

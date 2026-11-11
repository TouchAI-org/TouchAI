# 发版流程

面向维护者和 Agent。发布只通过 GitHub Actions；不要手工打 tag、创建 Release、上传安装包或修改 feed。

## 通道

| 通道 | 版本 | 触发方式 | 更新日志 |
| --- | --- | --- | --- |
| Stable | `X.Y.Z` | 合并 release-please 发布 PR | `release-notes/<version>.json` |
| Beta | `X.Y.Z-beta.N` | 在 `main` 手动触发 `release.yml` | 同一文件，触发前已在 `main` |
| Nightly | 自动生成或 `X.Y.Z-nightly...` | 定时任务，或手动触发 | 手动版本同上；自动定时任务例外，使用生成的说明 |

只有从 `main` 触发的 Beta/Nightly 才部署生产 feed。

## Agent 授权

用户提出发版时确认一次：通道、精确版本（自动 Nightly 可省略）、目标提交。确认后 Agent 可以连续完成日志准备、合并发布 PR、触发工作流、必要的环境确认和验证，不再逐项询问。只有目标提交、版本或通道发生变化时才重新确认。

## 发版前

```bash
git status --short --branch
git fetch origin
git rev-parse origin/main
```

- 工作区干净，Beta/Nightly 从最新 `main` 触发。
- 版本高于当前同通道版本；不允许降级。
- 面向用户的更新日志已完成两种语言并人工审核；必需检查已经通过。

## 更新日志

更新日志是给用户看的版本说明，不是提交记录、release-please 原始 changelog 或 GitHub 自动生成内容的直接拷贝。

- 首句说明这版最值得注意的结果。
- 按 `New Features` / `Fixes` / `Other Changes` 分组；只有一两个变化时可以只用一个编号列表。两种语言使用相同的分组、顺序和事实。
- 用编号列表，按影响从高到低排列；每条只讲一个变化，直接写用户能看到或做到什么。
- 避免“优化体验”“修复问题”这类空话；说明具体改了什么。
- 不写 commit hash、内部文件名、纯重构、测试或 CI 细节，除非它们直接影响用户。
- 保留相关的 `#issue` 或 `#PR`，让用户能追溯背景。
- 英文和中文都从实际 diff 重写：英文不要直接贴 changelog 或 commit list，中文不要逐字翻译英文；两种语言都使用自然、面向用户的表达。
- 可在末尾感谢重要贡献者。

正式发布（Stable、Beta、手动 Nightly）必须在 `apps/desktop/release-notes/<version>.json` 提交经审核的 `en-US` 与 `zh-CN`。文件属于被发布的提交，两种语言同时审查；任一缺失即不得发版。自动定时 Nightly 是内部验证构建，可以使用生成的说明；需要正式日志时，改为手动指定版本并先提交双语文件。

完整格式见 [`release-notes/README.md`](../apps/desktop/release-notes/README.md)。

## Stable

1. 找到并检查 release-please 发布 PR：

```bash
gh pr list --repo TouchAI-org/TouchAI --state open --search 'release-please' \
  --json number,title,url
gh pr checks <number> --repo TouchAI-org/TouchAI
```

2. 在同一个发布 PR 中加入 `apps/desktop/release-notes/<version>.json`，推回该 PR 并重新等待检查。缺少该文件时不要合并。

3. 合并发布 PR：

```bash
gh pr merge <number> --repo TouchAI-org/TouchAI --squash
```

4. 跟踪自动发布：

```bash
gh run list --repo TouchAI-org/TouchAI --workflow release-please.yml --branch main --limit 3
gh run watch <run-id> --repo TouchAI-org/TouchAI --exit-status
```

发布后再补当前版本的双语日志已经来不及；应用内 feed 使用发布时生成的内容。

## Beta

1. 确保 `apps/desktop/release-notes/<version>.json` 已经在 `main` 上。缺少该文件时不要触发。
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

默认由每日 18:00 UTC 的定时任务发布，不需要 Agent 操作；自动构建允许使用生成的说明。

需要面向用户的 Nightly 日志时，指定完整版本，并先把对应的双语文件合入 `main`：

```bash
gh workflow run release.yml --repo TouchAI-org/TouchAI --ref main \
  -f channel=nightly -f version=<version>
```

未指定精确版本的手动触发不具备正式日志，不要用于面向用户的发布。

## 发布后验证

```bash
gh release view v<version> --repo TouchAI-org/TouchAI \
  --json tagName,isDraft,isPrerelease,url,assets
```

正式版本确认 GitHub Release、安装包、`SHA256SUMS`、`provenance.sigstore.json` 和双语日志都存在。再检查生产 feed：

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

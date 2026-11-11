# 发版流程

面向维护者和执行发版的 Agent。发布只通过现有 GitHub Actions 工作流完成；不要手工打 tag、创建或修改 Release、上传安装包，或直接操作 Cloudflare R2/Worker。

## 发布模型

| 通道 | 触发方式 | 版本 | 更新日志来源 | 生产更新 feed |
| --- | --- | --- | --- | --- |
| Stable | 合并 release-please 发布 PR | `X.Y.Z` | `CHANGELOG.md` 的精确版本段；可用本地化 JSON 覆盖 | `releases.stable.json` |
| Beta | 在 `main` 手动触发 `release.yml` | `X.Y.Z-beta.N` | 本地化 JSON，或 GitHub 生成日志 | `releases.beta.json` |
| Nightly | 每日定时任务，或在 `main` 手动触发 | 自动生成，或手动的 `X.Y.Z-nightly...` | 本地化 JSON（仅手动指定精确版本时可用），或 GitHub 生成日志 | `releases.nightly.json` |

标签统一为 `v<version>`，例如 `v1.3.0`、`v1.3.0-beta.2`。

当前工作流只接受 Stable、`beta.*` 和 `nightly.*`。`alpha`、`rc` 虽然是合法的 semver 预发布标识，但当前发布校验会拒绝；如果以后需要，必须先单独修改并测试发布元数据校验，不能只改 tag。

只有从 `main` 触发的 Beta/Nightly 才会部署生产更新 feed。从其他分支或 SHA 手动触发只会构建并生成 GitHub Release/工作流产物，不会把版本推送给用户。

## 不可变规则

- 不在发布 PR 合并前抢跑 Stable。Stable 发布由 release-please 在发布 PR 合并后创建的 tag 驱动。
- 不手工创建 tag、GitHub Release、`SHA256SUMS` 或 provenance；这些都由工作流生成。
- 不重复使用已发布过的版本号。代码变化后必须使用更高的版本；Beta 递增 `beta.N`，Stable 由 release-please 计算下一个版本。
- 不允许降级。不要用旧 tag、旧 feed 或旧安装包覆盖已迁移的数据；出问题的版本用更高版本修复。
- 发布说明必须绑定到正在发布的版本。不要复用旧版本的中文内容，也不要在运行时调用机器翻译。
- 需要中文应用内更新日志时，Stable 必须在合并 release-please PR 前把 JSON 放进同一个发布 PR；Beta/Nightly 必须在触发工作流前把 JSON 合入 `main`。
- 免费签名只包括 GitHub OIDC/Sigstore 来源证明。它不等同于 Windows Authenticode 或 macOS Developer ID/公证；不要把它描述成已消除 SmartScreen/Gatekeeper 警告。
- Agent 可以准备发布、检查、触发已获批准的工作流并验证结果，但不得绕过保护环境、强推分支或使用管理员权限。

## Agent 的停机审批点

Agent 在以下三个动作前必须停下来，取得用户对“通道 + 精确版本 + 目标提交”的明确批准：

1. 合并 release-please 发布 PR。
2. 执行 `gh workflow run release.yml ...`。
3. 批准 `release` 或 `prerelease` 保护环境。

用户批准之前只能做只读检查、整理发布说明、运行测试和生成待执行命令。批准后如果目标提交、版本或发布说明发生变化，必须重新确认。

## 发布前检查

在准备或触发发布的工作区执行：

```bash
git status --short --branch
git fetch origin
git rev-parse --abbrev-ref HEAD
git rev-parse HEAD
git rev-parse origin/main
gh auth status
```

要求：

- 工作区干净；不要带着未提交修改发版。
- Beta/Nightly 的手动发布从最新的 `origin/main` 触发。
- 目标版本高于当前已发布的同通道版本；不要用 Beta 覆盖更高版本，也不要把 Stable 退回旧版本。
- 发布说明已由人审核；中文内容存在时同时检查英文内容。
- 发布 PR 或目标提交的必需检查已通过。没有通过时不要合并或触发。

## Stable 发布

Stable 不手动触发 `release.yml`。`release-please.yml` 的手动 dispatch 只用于刷新发布 PR，不应当作直接发版入口；发版仍以合并发布 PR 为准。release-please 维护版本号、`apps/desktop/CHANGELOG.md` 和发布 PR；合并发布 PR 后，由 `main` 上的工作流创建 `vX.Y.Z` tag、GitHub Release 和 Stable feed。

1. 找到发布 PR：

```bash
gh pr list --repo TouchAI-org/TouchAI \
  --state open \
  --search 'release-please' \
  --json number,title,headRefName,url
```

2. 检查版本、变更内容和 `CHANGELOG.md`：

```bash
gh pr view <number> --repo TouchAI-org/TouchAI \
  --json title,headRefName,url,files
gh pr checks <number> --repo TouchAI-org/TouchAI
```

3. 需要应用内中文日志时，在这个发布 PR 的分支上增加文件，并推回同一个 PR：

`apps/desktop/release-notes/<version>.json`

```bash
gh pr checkout <number> --repo TouchAI-org/TouchAI
# 编辑 apps/desktop/release-notes/<version>.json
git add apps/desktop/release-notes/<version>.json
git commit -m "docs(release): add <version> release notes"
git push
```

文件必须包含经人审核的 `en-US`（或 `en`）和可选的 `zh-CN` 内容。`en-US` 优先于 `en`；缺少英文时 Stable 使用 `CHANGELOG.md` 的精确版本段；缺少中文时只发布英文，不做机器翻译。详细格式见 [`apps/desktop/release-notes/README.md`](../apps/desktop/release-notes/README.md)。

如果 release-please 在合并前更新了发布 PR，重新确认该 JSON 仍在最终 diff 中，并且文件名与最终版本完全一致。

4. 检查通过并取得用户批准后合并发布 PR：

```bash
gh pr merge <number> --repo TouchAI-org/TouchAI --squash
```

5. 跟踪 release-please 运行：

```bash
gh run list --repo TouchAI-org/TouchAI \
  --workflow release-please.yml \
  --branch main \
  --limit 3
gh run watch <run-id> --repo TouchAI-org/TouchAI --exit-status
```

合并后不要再往 `main` 补当前版本的日志，也不要期待编辑 GitHub Release 页面会回写已经生成的 feed。发布页面的后续修改只影响该页面；应用内更新日志要进入 feed，必须在合并前准备好，或发布下一个更高版本修复。

### Stable 日志来源优先级

1. 发布 PR 中经审核的 `release-notes/<version>.json` 的 `en-US`/`en`。
2. 没有本地化英文时，使用 `apps/desktop/CHANGELOG.md` 中 release-please 生成的精确版本段。
3. 已发布 GitHub Release 正文若被维护者手工修正，准备作业会保留该修正，避免重试覆盖。

`CHANGELOG.md` 是 Stable 的默认英文来源，不是 Beta/Nightly 的来源。

## Beta 发布

Beta 使用精确的 semver 预发布版本，例如 `1.3.0-beta.1`。先选择版本，再准备日志，最后触发工作流。

1. 选择版本并确认它没有发布过：

```bash
gh release list --repo TouchAI-org/TouchAI --limit 30
```

Beta 版本必须高于当前已发布的 Beta；不要为了让 Beta 追上 Stable 而发布低于当前安装版本的版本。

2. 需要中文日志时，在触发前把文件合入 `main`：

`apps/desktop/release-notes/<version>.json`

通过正常 PR 流程提交和合并，或把该文件作为即将发布代码 PR 的一部分。不要只把文件放在本地分支或未合并的提交里，工作流只会读取目标提交上的文件。

3. 确认目标提交并取得用户批准：

```bash
git fetch origin
git rev-parse origin/main
gh run list --repo TouchAI-org/TouchAI --workflow release.yml --limit 5
```

4. 从 `main` 触发：

```bash
gh workflow run release.yml \
  --repo TouchAI-org/TouchAI \
  --ref main \
  -f channel=beta \
  -f version=<version>
```

5. 跟踪运行并等待保护环境审批：

```bash
gh run list --repo TouchAI-org/TouchAI \
  --workflow release.yml \
  --event workflow_dispatch \
  --branch main \
  --limit 3
gh run watch <run-id> --repo TouchAI-org/TouchAI --exit-status
```

如果运行停在 `prerelease` 环境，Agent 必须等待有权限的人批准；不要尝试绕过环境保护。

## Nightly 发布

Nightly 默认由每日 18:00 UTC 的定时任务生成，通常不需要 Agent 操作。定时任务从 `main` 构建，并跳过已经指向同一提交的 Nightly。

需要手动补一次 Nightly 时：

```bash
gh workflow run release.yml \
  --repo TouchAI-org/TouchAI \
  --ref main \
  -f channel=nightly
```

省略 `version` 时，工作流根据最新 Stable 的下一个补丁版本和运行编号生成版本。这也意味着无法提前知道文件名，因此自动生成的 Nightly 通常只能使用 GitHub 自动日志。

如果要让 Nightly 带中文日志，必须手动指定完整版本，并先把对应 JSON 合入 `main`：

```bash
gh workflow run release.yml \
  --repo TouchAI-org/TouchAI \
  --ref main \
  -f channel=nightly \
  -f version=1.3.1-nightly.20261111.1
```

手动 Nightly 版本必须是合法的 `nightly.*` 预发布版本。不要创建一个低于当前 Nightly 的版本。

## 发布后验证

至少检查以下内容：

```bash
gh release view v<version> --repo TouchAI-org/TouchAI \
  --json tagName,isDraft,isPrerelease,url,assets
```

确认：

- tag、版本号和通道正确；Stable 不是 prerelease，Beta/Nightly 是 prerelease。
- 目标平台的安装包、`SHA256SUMS`、`TouchAI-<version>.source.spdx.json` 和 `provenance.sigstore.json` 已上传。
- GitHub Release 正文与预期语言一致。
- 如果声明了中文日志，feed 的 `Latest.releaseNotesByLocale` 包含 `zh-CN`。
- 生产 feed 的 `Latest.version`/`Latest.tag` 指向刚发布的版本，而不是旧版本。

可以用 Node 检查 feed：

```bash
node -e '
  const url = process.argv[1];
  fetch(url)
    .then((response) => {
      if (!response.ok) throw new Error(`HTTP ${response.status}`);
      return response.json();
    })
    .then((feed) => console.log(JSON.stringify(feed.Latest, null, 2)))
    .catch((error) => {
      console.error(error);
      process.exit(1);
    });
' https://updates.touch-ai.org/touchai-app/v1/releases.stable.json
```

把最后的 URL 换成 `releases.beta.json` 或 `releases.nightly.json`。再按 [`release-verification.md`](release-verification.md) 验证下载文件的 SHA-256 和 Sigstore 来源证明。

R2 的发布顺序应为：先上传二进制，再上传 `releases.<channel>.json`，最后清理归档文件。若顺序或日志不符合预期，不要手工改 feed；停下来报告。

## 失败处理

| 现象 | 处理 |
| --- | --- |
| 发布 PR 或目标提交检查失败 | 不合并、不触发；修复后重新等待检查 |
| 构建失败，尚未部署 feed | 同一提交和版本可重跑失败作业；不要先改版本号 |
| GitHub Release 已创建但 feed 部署失败 | 重跑失败的部署作业；feed 在成功前仍指向旧版本，不能手工补写 |
| 已发布版本有严重 bug | 发布更高版本修复；不要把 feed 回退到旧版本 |
| 日志文字错误但尚未发布 | 修正发布 PR 或目标提交，重新检查 |
| 用户已经看到错误日志 | 修正 GitHub Release 页面只能修复页面；应用内要发更高版本 |
| 误合并了 Stable 发布 PR | 停止后续操作并通知维护者；不要删除 tag 或手工回退 feed |

重跑前先确认运行使用的提交没有变化。代码变化后必须使用新版本，不能把新代码塞进已经发布过的版本号。

## 给 Agent 的完成报告

发布结束后，向用户报告：

- 通道、版本、目标提交和 tag。
- 工作流运行链接及最终状态。
- GitHub Release 链接。
- 生产 feed 的 `Latest.version` 和 `Latest.tag`。
- 是否包含中文日志。
- 哪个平台或作业没有验证，以及原因。
- 需要人工跟进的审批、失败作业或回滚风险。

不要在报告里声称未实际运行的原生安装、签名、Gatekeeper 或性能验证已经通过。

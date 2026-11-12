# Release process

For maintainers and Agents. This runbook is intentionally not linked from the
project README. Releases run only through GitHub Actions. Do not create tags,
releases, upload assets, or edit update feeds by hand.

## Channels

| Channel | Version | Trigger | Release notes |
| --- | --- | --- | --- |
| Stable | `X.Y.Z` | Merge the release-please PR | `release-notes/<version>.json` |
| Beta | `X.Y.Z-beta.N` | Dispatch `release.yml` on `main` | The same file, committed to `main` |
| Nightly | Generated or `X.Y.Z-nightly...` | Schedule or manual dispatch | Manual versions use the same file; scheduled builds may use generated notes |

Only Beta and Nightly runs dispatched from `main` deploy the production feed.
Never downgrade. The app rejects an older version, and a published problem is
fixed with a higher version.

## Agent approval

Confirm the channel, exact version (optional for automatic Nightly), and target
commit once when the user requests a release. Then prepare notes, merge the
release PR, dispatch workflows, approve required environments, and verify the
result without asking again. Re-confirm only if the target commit, version, or
channel changes.

## Before releasing

```bash
git status --short --branch
git fetch origin
git rev-parse origin/main
```

- The worktree is clean, and Beta/Nightly runs use the latest `main`.
- The version is higher than the current release in the same channel.
- Reviewed notes exist in both languages, and required checks pass.

## Release notes

Release notes are user-facing, not commit logs or raw release-please
changelogs. Start with the most important user-visible outcome, then group
changes under `New Features`, `Fixes`, and `Other Changes`. Use one numbered
list when there are only one or two changes.

- Order items by impact and describe what the user can now see or do.
- Avoid vague claims such as "improved experience" or "fixed issues".
- Omit commit hashes, internal file names, refactors, tests, and CI details
  unless they directly affect users.
- Keep relevant issue or pull request references.
- Compare with the previous published release in the same channel. Only the
  first Beta falls back to Stable; never use Stable or Nightly as the Beta
  baseline.
- Rewrite English and Chinese from the actual diff. Both languages use the same
  structure and facts, in natural user-facing language; do not translate word
  for word.
- Thank significant contributors at the end when appropriate.

Formal releases (Stable, Beta, and manual Nightly) require reviewed `en-US` and
`zh-CN` content in `apps/desktop/release-notes/<version>.json` in the released
commit. Both languages are reviewed together; a missing language blocks
publication. Automatic scheduled Nightly is the internal-verification exception
and may use generated notes. For a user-facing Nightly build, dispatch an exact
version after committing the bilingual file.

```json
{
    "en-US": "This update makes interrupted downloads recoverable.\n\n## New Features\n\n1. **Resume updates**: continue a download after reconnecting (#776)",
    "zh-CN": "本次更新支持恢复中断的下载。\n\n## 新功能\n\n1. **断点续传**：重新联网后可以继续下载（#776）"
}
```

Do not reuse a file from an earlier version. Invalid JSON, missing content,
unknown language keys, non-string values, or notes longer than 64 Ki characters
fail preparation before the release is edited.

The JSON file is the only reviewed source. Publishing derives the legacy
English `releaseNotes` for older clients, the English Markdown used by
Velopack, and the GitHub Release body from it.

## Stable

1. Find and inspect the release-please PR:

```bash
gh pr list --repo TouchAI-org/TouchAI --state open --search 'release-please' \
  --json number,title,url
gh pr checks <number> --repo TouchAI-org/TouchAI
```

2. Add `apps/desktop/release-notes/<version>.json` to the same release PR, push
   it, and wait for checks. Do not merge without the file.

3. Merge the release PR:

```bash
gh pr merge <number> --repo TouchAI-org/TouchAI --squash
```

4. Track the automatic release:

```bash
gh run list --repo TouchAI-org/TouchAI --workflow release-please.yml --branch main --limit 3
gh run watch <run-id> --repo TouchAI-org/TouchAI --exit-status
```

Adding notes after publication is too late: the in-app feed uses the content
generated during the release run.

## Beta

1. Confirm `apps/desktop/release-notes/<version>.json` is already on `main`.
   Do not dispatch without it.
2. Dispatch the exact version:

```bash
gh workflow run release.yml \
  --repo TouchAI-org/TouchAI \
  --ref main \
  -f channel=beta \
  -f version=<version>
```

3. Track the run and complete any required environment approval:

```bash
gh run list --repo TouchAI-org/TouchAI --workflow release.yml \
  --event workflow_dispatch --branch main --limit 3
gh run watch <run-id> --repo TouchAI-org/TouchAI --exit-status
```

## Nightly

The scheduled build runs daily at 18:00 UTC and needs no Agent action.
Scheduled Nightly builds may use generated notes.

For a user-facing Nightly release, specify the full version and commit the
corresponding bilingual file to `main` first:

```bash
gh workflow run release.yml --repo TouchAI-org/TouchAI --ref main \
  -f channel=nightly -f version=<version>
```

A manual dispatch without an exact version has no formal notes and must not be
used for a user-facing release.

## Verify after release

```bash
gh release view v<version> --repo TouchAI-org/TouchAI \
  --json tagName,isDraft,isPrerelease,url,assets
```

For a formal release, confirm the GitHub release, installers, `SHA256SUMS`,
`provenance.sigstore.json`, and bilingual notes exist. Then check the production
feed:

```bash
node -e 'fetch(process.argv[1]).then(r => r.json()).then(f =>
  console.log(JSON.stringify(f.Latest, null, 2)))' \
  https://updates.touch-ai.org/touchai-app/v1/releases.stable.json
```

Use `releases.beta.json` or `releases.nightly.json` for the other channels.

For package verification, run:

```sh
gh attestation verify './TouchAI-<version>-windows.msi' \
  --repo TouchAI-org/TouchAI \
  --signer-workflow TouchAI-org/TouchAI/.github/workflows/velopack-build.yml
sha256sum './TouchAI-<version>-linux.AppImage'
```

Use `shasum -a 256` on macOS and `Get-FileHash -Algorithm SHA256` on Windows.
The digest must match the corresponding line in `SHA256SUMS` from the same
release. Free signing is GitHub/Sigstore keyless provenance only; it is not
Windows Authenticode or macOS Developer ID/notarization, so OS warnings can
still appear. Never disable OS security checks to install the app.

## Failure handling

| Situation | Action |
| --- | --- |
| A check or build fails | Rerun the failed job for the same commit and version; do not change the version first |
| The GitHub release exists but feed deployment fails | Rerun the deployment job; do not edit the feed by hand |
| A published version has a serious bug | Publish a higher version; do not roll back the feed or downgrade |
| Users already received incorrect notes | Edit only the GitHub release page; ship a higher in-app version |
| A Stable release PR was merged by mistake | Stop and notify maintainers; do not delete tags or roll back the feed by hand |

After release, report the channel, version, commit, workflow link, release
link, feed version, and anything that was not verified.

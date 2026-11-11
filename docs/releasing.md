# Release process

For maintainers and Agents. Releases run only through GitHub Actions. Do not
create tags, create releases, upload installers, or edit update feeds by hand.

## Channels

| Channel | Version | Trigger | Release notes |
| --- | --- | --- | --- |
| Stable | `X.Y.Z` | Merge the release-please PR | `release-notes/<version>.json` |
| Beta | `X.Y.Z-beta.N` | Dispatch `release.yml` on `main` | The same file, already committed to `main` |
| Nightly | Generated or `X.Y.Z-nightly...` | Schedule or manual dispatch | Manual versions use the same file; scheduled builds may use generated notes |

Only Beta and Nightly runs dispatched from `main` deploy the production feed.

## Agent approval

When the user requests a release, confirm the channel, exact version (optional
for automatic Nightly), and target commit once. After that, the Agent may
prepare notes, merge the release PR, dispatch workflows, confirm required
environments, and verify the result without asking again. Re-confirm only when
the target commit, version, or channel changes.

## Before releasing

```bash
git status --short --branch
git fetch origin
git rev-parse origin/main
```

- The worktree is clean, and Beta/Nightly runs use the latest `main`.
- The version is higher than the current release in the same channel; downgrades
  are not allowed.
- User-facing notes are reviewed in both languages, and required checks pass.

## Release notes

Release notes are user-facing. They are not commit logs, raw release-please
changelogs, or verbatim GitHub-generated content.

- Start with the most important user-visible outcome.
- Group changes under `New Features`, `Fixes`, and `Other Changes`. Use one
  numbered list when there are only one or two changes.
- Order items by impact. Each item describes one change and what the user can
  now see or do.
- Avoid vague claims such as "improved experience" or "fixed issues".
- Omit commit hashes, internal file names, pure refactors, tests, and CI details
  unless they directly affect users.
- Keep relevant issue or pull request references.
- Compare with the previous published release in the same channel. Only the
  first Beta falls back to Stable; never use Stable or Nightly as the Beta
  baseline.
- Rewrite English and Chinese from the actual diff. Do not paste a changelog or
  commit list into English, and do not translate Chinese word for word. Both
  languages use the same structure and facts, in natural user-facing language.
- Thank significant contributors at the end when appropriate.

Formal releases (Stable, Beta, and manual Nightly) must include reviewed
`en-US` and `zh-CN` content in `apps/desktop/release-notes/<version>.json` in
the released commit. Both languages are reviewed together; a missing language
blocks publication. Automatic scheduled Nightly is the internal-verification
exception and may use generated notes. For a user-facing Nightly build, dispatch
an exact version after committing the bilingual file.

See [`release-notes/README.md`](../apps/desktop/release-notes/README.md) for the
file format.

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
See [`release-verification.md`](release-verification.md) for signature and
checksum verification.

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

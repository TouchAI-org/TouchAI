# Release notes

For the complete Stable/Beta/Nightly process and Agent release workflow, see
[`docs/releasing.md`](../../../docs/releasing.md).

Every Stable, Beta and manually versioned Nightly release requires
`<version>.json` in this directory, for example `0.3.0-beta.2.json`. The file
contains reviewed `en-US` and `zh-CN` content and belongs to the commit being
released. Do not reuse a file from an earlier version. Automatic scheduled
Nightly builds are the internal-verification exception and may use generated
notes; a user-facing Nightly release must use the same reviewed bilingual file.

Write user-facing notes, not commit logs: a one-sentence intro, then
`## New Features`, `## Fixes`, and `## Other Changes` as needed; use numbered
items with the relevant issue or PR. Both languages must be rewritten from the
actual diff, share the same structure and facts, and receive human review. Do not
publish raw release-please changelog entries or commit lists as release notes.

```json
{
    "en-US": "This update makes interrupted downloads recoverable.\n\n## New Features\n\n1. **Resume updates**: continue a download after reconnecting (#776)",
    "zh-CN": "本次更新支持恢复中断的下载。\n\n## 新功能\n\n1. **断点续传**：重新联网后可以继续下载（#776）"
}
```

The example is authoring guidance, not a release announcement. Put the file in
the same release PR as the version change for Stable, or commit it to `main`
before dispatching Beta/manual Nightly. Invalid JSON, missing content, unknown
language keys, non-string values and notes longer than 64 Ki characters fail
preparation before the release is edited. The automatic scheduled Nightly path
is the only generated-notes exception.

The workflow produces:

- `release-notes.md`: English Markdown for existing Velopack clients.
- `release-notes.json`: the reviewed language map, attached to the GitHub release
  and included as `Latest.releaseNotesByLocale` in the update feed.
- `release-body.md`: both reviewed languages for the GitHub release page.

`SchemaVersion: 1`, `Latest.releaseNotes` and Velopack `NotesMarkdown` remain
compatible. Desktop settings, required updates and notifications select the
current language first.

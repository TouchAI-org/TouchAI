# Localized release notes

For the complete Stable/Beta/Nightly process and Agent approval boundaries, see
[`docs/releasing.md`](../../../docs/releasing.md).

Stable release notes start with the exact version section from `CHANGELOG.md`,
which release-please writes in the release PR. The generated English text is the
default for the GitHub release, Velopack metadata and the update feed. Beta and
Nightly releases do not consume this changelog because they are not managed by
release-please.

Add `<version>.json` in this directory, for example `0.3.0-beta.2.json`, when a
release needs reviewed wording or a translation. Put the file in the same release
PR as the version change so it is reviewed before publishing. The file belongs to
the commit being released. Do not reuse a file from an earlier version or translate
notes at runtime.

```json
{
    "en-US": "## Improvements\n\n- Retry an interrupted update without losing progress.",
    "zh-CN": "## 改进\n\n- 更新中断后可重试，无需丢失下载进度。"
}
```

These are example authoring strings, not a release announcement. Have a human
review both languages against the actual diff before publishing. The reviewed
`en-US`/`en` and `zh-CN` entries override the release-please changelog. `en` is
accepted as an English alias; `en-US` wins when both exist. Empty translations are
omitted. Unknown language keys, non-string values, invalid JSON and notes longer
than 64 Ki characters fail preparation before the release is edited.

If a Stable release has no reviewed English entry, preparation uses the exact
release-please `CHANGELOG.md` section. A published body that differs from that
section is treated as a maintainer correction and is kept, so retrying a build
does not discard a hotfix edit. If neither source exists, preparation preserves an
existing GitHub release body or asks GitHub to generate notes. Beta and Nightly
use the published body first, then GitHub-generated notes. Generated bilingual
bodies mark the English section so a retry does not nest translations or duplicate
the notes. Only preparation edits the release body; platform packaging cannot
overwrite it with compatibility-only English. There is no paid translation API or
unreviewed machine-translation step. Missing Chinese content falls back to English.

Generated Beta notes explicitly compare to the greatest **published lower Beta
version**, not the latest Stable or Nightly release. Nightly follows Nightly, and
Stable follows Stable. Drafts, newer tags and non-version tags are excluded. Only
the first release of a prerelease channel falls back to an earlier Stable release;
when no baseline exists, GitHub generates the initial release history.

The workflow produces:

- `release-notes.md`: English Markdown for existing Velopack clients.
- `release-notes.json`: language map, attached to the GitHub release and included
  as `Latest.releaseNotesByLocale` in the update feed.
- `release-body.md`: both available languages for the GitHub release page.

`SchemaVersion: 1`, `Latest.releaseNotes` and Velopack `NotesMarkdown` remain
compatible. Desktop settings, required updates and notifications select notes in
the app language, then English, then matching-version legacy notes. Changing the
language while the dialog is open does not fetch, reinstall or remount the app.

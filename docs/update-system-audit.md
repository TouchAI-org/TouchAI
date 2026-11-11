# Installation, release, and update audit

This work is consolidated in PR #776 instead of separate worktrees or parallel
update systems. Related issues: #766, #767, #768, #769, #771, #772, #773, #777.

## Flow and ownership

1. `release-please.yml` manages Stable versions and `CHANGELOG.md`.
   `release.yml` manages Beta and Nightly.
2. Release-please maintains versions and engineering changelog history. Formal
   user-facing notes come from `release-notes/<version>.json`, which must contain
   reviewed `en-US` and `zh-CN` content. Stable, Beta, and manual Nightly fail
   preparation when either language is missing. Automatic scheduled Nightly is
   the internal-verification exception and may use generated notes. The
   preparation script writes Markdown, localized JSON, and the GitHub release
   body.
3. `velopack-build.yml` builds the Windows MSI/Velopack package and the macOS
   and Linux installers. Historical Velopack packages are used only for delta
   generation and never enter the public manifest for this version.
4. The aggregate job selects this version's artifacts, generates a
   source-dependency SBOM, a streaming SHA-256 manifest, and Sigstore provenance,
   then uploads the GitHub release. Attestation failure is not treated as a
   warning.
5. Cloudflare R2 receives binaries first and channel feeds only after binary
   uploads succeed. Archived files are pruned last. The Worker keeps the
   existing cache/GitHub fallback, Range/HEAD behavior, and origin restrictions.
6. The native update layer reads the feed. Velopack decides version and delta
   behavior and owns final package verification and installation. The HTTP
   transport uses the existing reqwest/sha2 dependencies and adds bounded resume
   support on the existing partial path.
7. `AppUpdateService` owns settings, check cadence, retries, and cross-window
   results. Settings, the required-update gate, and notifications use the same
   type contract and language-selection rules.

## Implemented improvements

| User-facing gap | Change |
| --- | --- |
| A new Beta/Nightly install checked Stable by default | Derive the initial channel from the installed app version; saved preferences still win |
| Channel switching could downgrade a migrated database | Native updates explicitly reject downgrades; numeric Beta ordering is retained |
| Release-note baselines could be wrong | Generated Nightly notes compare with the previous published Nightly; Beta notes compare with the previous published Beta, and only the first Beta falls back to Stable |
| Formal notes had one language or copied commits | Stable, Beta, and manual Nightly require reviewed bilingual files; both languages are rewritten from the actual diff |
| Notes could drift from the released version | Use a version-specific file from the released commit; release-please `CHANGELOG.md` remains engineering history, and only scheduled Nightly may use generated notes |
| A retry or packaging job could overwrite notes | Formal releases read only the version file; only the preparation job writes the release body, so retries keep it stable |
| A failed download or install always sent users to a web page | Keep retryable candidates and reuse a downloaded package when installation is retried |
| Closing a download dialog was labeled "Cancel" | Rename it to "Continue in background" and let "View download" reopen progress without checking or downloading again |
| Interrupted downloads restarted from zero | Resume when SHA-256 metadata exists; validate the exact Range, length, and post-resume digest instead of trusting any appended bytes |
| A CDN ignored or rejected ranges, or partial bytes were corrupt | Restart safely; legacy feeds without SHA-256 always download in full and never reuse partial data |
| Network requests could wait forever | Add connection and idle read timeouts; scale the in-memory transfer budget by declared size; use bounded streaming buffers and sparse progress events |
| Offline checks interrupted users and recovery waited too long | Skip automatic checks offline; back off online failures at 1/2/4/8/16/32/60 minutes; resume the normal cadence after success |
| The OS could report offline incorrectly | Manual checks still attempt the real native request instead of treating the online hint as authoritative |
| A new feed could appear before its files uploaded | Split publication into binaries first and feeds second; a failed first step stops the second |
| An R2 outage skipped an available archive | Versioned binaries still try the cache and GitHub fallback; feed errors do not pretend to succeed |
| Users could not find notes for their installed version | Add a read-only entry point for matching notes without checking, installing, or downgrading |
| Users did not know the package size before downloading | Show the declared full package size without presenting it as delta traffic or time remaining |
| Users could only trust a file name | Publish final-artifact checksums, keyless build provenance, a downloadable proof bundle, and a source-dependency SBOM |

## Compatibility and safety boundaries

- No database, migration, persisted JSON shape, CSP, tool permission, or
  telemetry-content changes.
- The feed remains `SchemaVersion: 1` and keeps `releaseNotes` and Velopack
  `NotesMarkdown`. New clients can read old feeds; old clients keep compatible
  content.
- Language selection prefers the current language, then English, then
  notes for the matching version. A downloaded version is never labeled with
  notes for a different version.
- Resume does not bypass Velopack's final verification, install path, or
  downgrade prohibition. It creates no second download-state database. Repeated
  server errors still fail clearly instead of marking a damaged file as
  downloaded.
- Automatic failure counts are in memory and bounded. The existing 08:00 to
  midnight check window is retained. Rescheduling and page exit remove the
  timers and listeners created by this run.
- "Continue in background" is not a cancel API and does not force installation.
  The user still confirms installation.
- The current-version notes entry uses already-fetched matching feed data. It
  adds no installed-version history store or startup prompt. If the channel has
  moved on, earlier notes remain available on the GitHub release page.

## Implementation choices

- Keep Velopack's install, delta, and verification behavior instead of replacing
  the updater. The installed Velopack 1.3.39-g8d2844f HTTP downloader uses
  `File::create` and has no suitable default timeout, so only the HTTP transport
  is replaced. The shared `core/download.rs` module is reused by update packages
  and font CDN downloads for Range, length, SHA-256, retry, and progress policy.
  It still uses reqwest for HTTP/TLS and sha2 for hashing.
- Reuse the existing version parser and channel validation in release scripts.
  Frontend comparison uses the existing `semver` package's `valid` and `gt`
  functions instead of a hand-written regex comparator.
- Generate the cross-platform manifest with Node's built-in streams and crypto,
  without a new dependency or reading large files into memory.
- Use pinned GitHub `actions/attest` and Anchore SBOM actions with a pinned Syft
  version. No compatibility wrapper around a deprecated attestation action is
  added.
- Do not depend on paid translation or send user content to a translation
  service, and do not treat unreviewed machine translation as release fact.

## Not solved by this change

- Free keyless provenance is not Windows Authenticode or macOS Developer
  ID/notarization. SignPath Foundation requires a maintainer application, and
  the relevant Apple program is normally paid.
- The SBOM is a source-dependency inventory, not a complete inventory of OS
  components in the installed package and not a vulnerability scan.
- The app does not roll back the database or use an older installer to undo an
  update. Publish a higher version to fix a released problem.
- Staged validation still uses Beta/Nightly and the protected Stable
  environment. This change does not add percentage rollout, remote revocation
  of downloaded packages, or a release-control backend.
- CI configuration and static checks are not a real signed publication. This
  work did not create a tag, deploy the Worker or R2, accept service terms, or
  migrate production data.
- Component screenshots and unit tests do not replace Windows installed-package
  upgrades, macOS Gatekeeper checks, Linux package-manager checks, or native
  release-build performance acceptance. Unverified items are listed in the PR.

## Maintenance entry points

- [Release process](releasing.md)
- [Release notes format](../apps/desktop/release-notes/README.md)
- [Installation and update verification](release-verification.md)

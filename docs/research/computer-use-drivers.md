# Computer control drivers — RFC #111 / PR #730

## Acceptance scenarios

- Given an existing cua-driver installation, when the user installs agent-desktop,
  then each driver has its own verified installation and removing one preserves the other.
- Given two drivers, when the user selects another driver, then subsequent discovery,
  invocations, updates and recording use that driver; existing actions are cancelled and
  previous window approvals are forgotten.
- Given agent-desktop, when the model discovers tools, then it receives the complete
  upstream catalog and native argument schemas, without cua-specific instructions.
- Given a disabled tool group, when a direct call or batch uses it, then the action is
  refused before reaching the driver. Foreground input respects the foreground switch.
- Given a running MCP action, when cancellation or a timeout occurs, then the adapter
  sends the upstream cancellation notification. Already completed effects are not undone.
- Given recording is enabled, when the driver restarts or the user changes the location,
  then the next action records under the selected driver's directory without overwriting
  a previous run. Turning recording off prevents subsequent trace writes.
- Given a missing, corrupt or unavailable driver, when the user selects it, then the
  settings page shows that state and never presents an unrelated driver's version as ready.
- Given a cua-driver action has finished, when the user switches drivers, then delayed
  native callbacks cannot execute unloaded DLL code. Driver/session handles are destroyed,
  but the Windows library remains mapped until the process exits. Opening settings alone
  must not load that library.
- Given a driver is not installed or is unavailable, when the user opens its option,
  then it cannot be selected, while its download/removal actions remain reachable.
- Given the active driver is successfully removed, when another usable driver remains,
  then subsequent settings and actions use that driver. Failed removal keeps the choice.
- Given no usable driver remains, when settings load or removal completes, then no extra
  notice row appears, no driver is presented as selected, and only
  installation controls remain interactive. Permission and behaviour settings keep their
  values and layout but are disabled. Installing a driver enables its settings again.
- Given a removal is awaiting confirmation or completion, when the user views settings,
  then every page control is disabled and the existing sections stay mounted. Cancellation
  or failure restores the previous controls; successful final removal keeps preferences
  disabled while allowing a new installation.
- Given a Windows cua library was already loaded, when its installation is removed,
  then it immediately becomes unavailable, even if it was the only driver. Locked files
  are retired for cleanup on the next launch, without unloading live library code.
  Reinstallation creates an independent verified installation.
- Given agent-desktop is selected, when reviewing permissions, then the page describes
  batches and trace export rather than scripts/replay, hides unsupported browser/image
  preferences and offers only approval modes that the adapter implements.

## Integration decision

Keep cua-driver as the default. Use agent-desktop v1.2.0's stdio MCP server rather than
its FFI: MCP exposes the complete CLI schemas, window targeting, batch commands,
image content and request cancellation. Reuse rmcp, the existing download verifier,
and the installed flate2/tar crates. Do not emulate either driver's element references
or silently translate incompatible coordinates. Driver identity is an independent
settings key; the existing settings JSON and database schema stay unchanged.

Runtime, snapshots and records belong to a driver. A backend mismatch is an error,
never a reason to send a call to the other driver. Installations remain pinned to
reviewed release hashes; an update check does not execute an unverified new release.

## Compatibility boundary

- The existing `computer_use` tool dispatches to the selected driver. Each driver exposes
  its native schema; element tokens, ref IDs, window IDs and coordinate systems are not
  interchangeable. Switching cancels pending work, stops the runtime, and clears approvals
  and the tool catalog.
- Group permissions inspect every command inside an agent-desktop batch. A failed or
  unstarted command makes the outer result unsuccessful even when the batch envelope says
  `ok: true`. Responses reuse structured content instead of duplicating the same JSON.
- The agent-desktop Windows adapter requires foreground permission for input, automation
  and window mutations. Upstream headless operation can still activate a window; it is
  not an isolation guarantee. Read-only discovery remains available.
- Recording defaults to `CACHE/computer-use-trajectories/<driver>/recording-<uuid>/`.
  Newly chosen directories acquire the driver suffix. Existing custom cua locations are
  retained without moving data. agent-desktop writes `trace.jsonl`; cua owns its native
  trajectory format. Enabling recording is idempotent within a runtime and resumes after
  runtime recreation. It is diagnostic data, not a promise of deterministic replay.
- agent-desktop runs as a bounded, serial stdio MCP service using the existing rmcp
  dependency. Cancellation sends the upstream notification, whose handler kills the
  active CLI child. Completed effects are not rolled back. A disconnected transport is
  recreated on the next call; mutating actions are never automatically replayed.
- Windows cua DLLs remain mapped until process exit, using libloading's `Library::pin()`.
  Driver and session handles are still released. Removal is serialized with installation
  and runtime restoration, cancels active calls and retires the installation under
  `computer-use.removed/<uuid>/`. It immediately disappears from driver availability.
  Cleanup is attempted immediately; if files are locked, the remaining retired files
  are logged for cleanup on the next launch. Cleanup runs off the UI thread and only
  visits retired UUID directories.
  Reinstallation uses the original install location, independently of retired files.
  Settings status checks do not load the DLL.

## Candidate research (2026-11-07)

Only cua-driver and agent-desktop are implemented. The candidates below are not shown as
working choices in settings. They need platform-specific tests before being offered.

| Candidate | Fit and evidence | Integration work and unresolved constraints | Recommendation |
| --- | --- | --- | --- |
| [agent-desktop v1.2.0](https://github.com/vercel-labs/agent-desktop/releases/tag/v1.2.0) | Apache-2.0; native Windows/macOS/Linux releases; stdio MCP exposes 67 tools in the Windows release tested here | Verified downloader, MCP lifecycle, native tool schemas, batch permission checks, recording and feedback are implemented. Clean Windows CRT dependency, headless focus behavior and unsupported UIA patterns remain upstream constraints. | Available as a second driver; keep cua as default |
| [Windows-MCP](https://github.com/CursorTouch/Windows-MCP) | MIT; Windows 10/11; UIA discovery/actions; stdio and HTTP transports | Current README requires Python 3.14+ and uv. Needs pinned runtime/package delivery, telemetry disabled by default, grouping of PowerShell/Registry/file tools, and verification that cancellation stops native work. A generic MCP connection alone does not provide driver lifecycle parity. | Best next Windows PoC |
| [Peekaboo](https://github.com/openclaw/Peekaboo) | MIT; macOS 15+; CLI/MCP, screenshots and Accessibility actions | Native release can host MCP; npm launcher requires Node 22+. Needs signed distribution, TCC onboarding, ScreenCaptureKit/Accessibility validation and a macOS test machine. | Best macOS candidate; not testable on this Windows host |
| [Terminator](https://github.com/mediar-ai/terminator) | MIT; current official feature matrix says Windows only; selectors, background actions and MCP | Rust/native package distribution and Node launcher need release verification. Background actions, ambiguous windows and cancellation require real regression tests. Latest release was not confirmed in this research run. | Secondary Windows comparison, after Windows-MCP |
| [nut.js](https://github.com/nut-tree/nut.js) | Cross-platform input and screenshot primitives | Lower-level library rather than equivalent ready-made driver. Requires Node runtime, a larger adapter, semantic targeting and permission handling; verify distribution terms for prebuilt plugins separately. | Low priority; useful for missing primitives |

Planning estimates for one Windows engineer, excluding upstream fixes and platform CI:
Windows-MCP PoC 3–5 working days, shippable integration 8–15; Terminator PoC 4–7,
shippable integration 10–18. Peekaboo with a macOS environment: PoC 3–5, shippable
integration 8–15. These are estimates based on the integration boundary above, not
measured effort or delivery commitments. Implementing every candidate immediately
would multiply runtime packaging and cancellation paths before establishing a benefit.

Source checks used official repositories and the pinned agent-desktop source at commit
`2b0a7334fc111730454b726e6800aa41cdafc093`, including its [MCP implementation](https://github.com/vercel-labs/agent-desktop/tree/v1.2.0/src/mcp).
Additional Peekaboo references: [MCP guide](https://github.com/openclaw/Peekaboo/blob/main/docs/MCP.md)
and [platform support](https://github.com/openclaw/Peekaboo/blob/main/docs/platform-support.md).

## Validation scope

Windows native validation uses an isolated TouchAI profile, the real Tauri IPC layer,
the application's `ComputerUseTool`, and a dedicated WinForms fixture. No model is
involved in these deterministic driver tests. They are not OSWorld, Windows Agent Arena,
WebArena or ScreenSpot official benchmark scores, and do not establish an LLM task
success rate. macOS/Linux and clean-machine dependencies require separate validation.

The direct `desktop_select` action fails on the fixture's WinForms ComboBox with
`ACTION_NOT_SUPPORTED`: its snapshot advertises SetValue/SetFocus, not Select. A single
batch of focus + Home/Down/Return + snapshot succeeds and verifies the selected value.
The model guidance now instructs using available actions and this keyboard route where
appropriate. This is a demonstrated upstream capability limit, not an adapter success.

### Windows results, 2026-11-07

- 213 frontend tests in eight relevant files; 44 Rust computer-use tests, including the
  real cua DLL and agent-desktop release fixture. Application/test type checks, targeted
  ESLint/Prettier and the debug native build passed.
- Six alternating driver cycles completed 24 real observe/key/set-value operations
  without errors over 45.631 seconds. The loaded-DLL removal guard preserved the install.
  After restart, opening settings did not load cua; each driver could be removed and
  reinstalled while preserving the other.
- The original functional fixture passed 12 of 13 assertions; direct ComboBox Select was
  the sole unsupported operation. Its separately tested keyboard batch succeeded.
- Both drivers wrote nonempty records and resumed recording after runtime recreation.
  With recording disabled, further native movement left all 57 existing trace files
  unchanged. Settings showed the driver-specific path only while recording was enabled.
- Real foreground pointer movement matched the overlay under 150% DPI. The glow stayed
  visible across idle time in an active task, remained unfocused, and hid on normal end
  and abort, verified through Win32 window visibility. Minimum/default settings sizes
  (920×560 and 1120×700) had no horizontal overflow.

These checks do not replace full `pnpm test:pr`, WDIO/coverage gates, clean-machine checks,
non-Windows validation or release-profile P50/P95 and memory measurements. No model was
called in this deterministic compatibility run; model success and latency improvements
have not been established. Maintainer review is still required before merge.

### Driver availability settings, 2026-11-08

The dropdown now disables uninstalled/unavailable choices while preserving their separate
download and removal buttons. The service also rejects unavailable selections before
cancelling the current runtime. Successful removal of the active driver selects the other
usable installation; failed removal preserves the selection. With no usable installation,
the page shows an empty selection and installation actions, without a separate notice row.
Permissions and behaviour remain visible with their saved values but are disabled
until a driver is available. The first successful
installation selects that driver; installing an additional driver keeps the current choice.

Agent-desktop settings describe batch actions and trace viewing/export, hide browser and
image-size preferences, and omit the unimplemented per-window approval choice. An existing
per-window preference is displayed as per-action approval for agent-desktop, matching its
execution behaviour; the stored cua preference is retained when switching back. Shared
settings and independent recording locations keep their existing persistence format.

Regression tests reproduced 13 failures before the changes. The final five-file frontend
suite passed 232 tests. Native settings interaction verified removal of cua with automatic
fallback to agent-desktop, removal of the final driver, two disabled options with usable
download buttons, installation of both drivers, first-install selection, unchanged selection
on second install and animated loading. The empty state was checked at 1120×700 and
920×560 without horizontal overflow. These earlier availability checks preceded the stable
layout and loaded-library removal correction below; their no-driver visibility assertion
has been replaced by the user's disabled-settings requirement.

### Stable settings and final-driver removal, 2026-11-08

The reproduction separated two causes: permissions and behaviour used an installation
condition that unmounted them, while Windows refused every removal after cua had loaded
its DLL. The latter was unrelated to the number of installed drivers.

The page now preserves its sections throughout confirmation, deletion and the empty state.
One disabled-state rule covers all preference controls, including foreground, cursor,
recording and the directory picker. Driver management stays available in the empty state.
Confirmation, deletion and refresh lock every page control, including the master switch;
cancel or failure unlocks the same controls. Removal no longer requires unloading the DLL
or asking the user to restart before removing it. Settings and recording paths retain their
existing storage format; no database schema or persisted settings shape changes.

The final layout also removes the separate no-driver notice at the user's request. The
empty dropdown and disabled controls express availability without another row.

Validation:

- The initial stable-layout regression run failed three UI scenarios; the loaded-DLL
  native regression failed with the original restart-required error. Both passed after
  the owning-layer changes. Removing the notice subsequently produced three expected
  UI failures before its template and translation entries were removed.
- The final four-file frontend run passed 129 tests. The native `computer_use` suite
  passed 47 tests with the real cua DLL and agent-desktop archive, including the manually
  enabled integration cases. The native debug build passed.
- Application and test TypeScript checks, targeted ESLint and Prettier checks, and the
  changed Rust files' formatting checks passed.
- Real Windows settings interactions verified cancelled removal, removal of the sole
  loaded cua driver, reinstallation, automatic selection of the remaining agent driver,
  and preservation of that choice when another driver is installed. The sole loaded cua
  removal took about 0.4 s in one UI observation, including refresh; this is not a latency
  distribution or a release performance benchmark.
- Removing the final agent-desktop driver also succeeded. The final empty state had no
  separate notice, retained disabled preferences and usable installation controls, and
  showed no horizontal overflow at 1120×700 or 920×560. Both drivers were reinstalled
  afterwards and cua-driver was selected for the restored profile.
- After restart, the retired installation directory was empty and installed drivers
  remained available. Existing preferences were retained and recording stayed disabled
  throughout this isolated-profile run.

These are targeted Windows checks. The full PR/WDIO/coverage gates, non-Windows deletion
semantics and release-profile P50/P95/memory budgets were not revalidated in this follow-up.
The driver checks did not execute a model-driven task and do not represent benchmark scores.

Settings research and recommendations are in [computer-use-settings.md](computer-use-settings.md).

### Version and storage management acceptance, 2026-11-08

- Given the bundled RTK manifest, when maintaining supported driver releases, then one
  resource manifest owns RTK, cua-driver and agent-desktop versions and verified artifacts.
- Given either installed driver, when choosing a storage directory, then both drivers move
  beneath that directory as `<driver>/<version>`, preserve their bytes, and remain usable.
  Cancellation, destination conflicts or a failed copy leave the original installation active.
- Given the previous cua installation layout, when using the new build, then its verified
  files migrate into the common driver directory without downloading them again.
- Given an older release, when the new release has downloaded but failed to start, then
  the old files and active-version record remain intact. Only successful startup and tool
  discovery commit the new version and remove obsolete managed versions and download caches.
- Given Windows locks on retired libraries, when cleaning an old installation, then the
  installation becomes unavailable immediately and locked files are retried on next launch.
- Given a domestic or international network, when downloading agent-desktop, then the source
  preference follows bounded connectivity probes, with verified fallback between npm mirror and
  npm origin. A source returning corrupt bytes never counts as a successful download.
- Given no installed drivers, when viewing settings, then storage selection remains available
  while operation preferences remain disabled. Relocation locks settings until it finishes.

The requested setting and cleanup policy use the existing settings table; no table, column,
index or migration changes are required. New source selection does not add model calls.

### Shared versions, mirrors and storage implementation

The previous `resources/rtk/manifest.json` is now
`apps/desktop/src-tauri/resources/binaries.json`. Its `rtk`, `cua-driver` and
`agent-desktop` entries own the bundled/recommended versions and pinned artifacts.
RTK's build-time provisioner and both desktop runtime adapters read this same file.
Maintainers update the relevant version, per-platform archive entries, sizes and digests,
then verify startup and the tool contract on supported platforms. Update checks report
upstream versions; they do not install an unreviewed upstream release.

The default layout is `<app data>/assets/bin/computer-use-drivers/<driver>/<version>`.
The driver section exposes a Custom location picker, empty by default. The runtime
resolves its default from the current app directory without saving that path. A custom
parent nests installations beneath `computer-use-drivers`; only that custom installation
root uses `computer_use.driver_directory` in the existing settings table. Clearing the
selection migrates drivers back and deletes the preference. Moving storage takes
an exclusive native lease, stops the runtimes, copies and hashes files into temporary
staging, commits the directory preference transaction, and retires the source driver
directories. Cancellation, path conflicts and persistence failures preserve the source.
Recording locations are independent and retain the driver suffix. Missing custom storage
can be replaced with a new location even when no driver is available.

Copies use the installed `tempfile` and `sha2` crates plus standard filesystem operations.
The generic startup copy helper follows links and does not validate copied bytes; it is
therefore unsuitable for this boundary. This small driver-specific copy rejects links
and special files and validates each regular file. It never removes unrelated files in
the chosen root. Pending Windows DLL deletion uses the existing retirement mechanism;
the directory is renamed immediately and locked files are retried on a later start.

[Magpie's source policy](https://github.com/yetone/magpie/blob/main/internal/source/source.go)
reads the user-controlled `ChinaMirror` setting. It does not infer China from IP, language
or timezone. TouchAI instead races bounded HEAD probes of the configured official and
mirror URLs (at most three seconds) and tries the first successful source, then remaining
sources if download or integrity validation fails. No geolocation service or model is
involved. This adapts to actual network routing, including overseas proxies; it is not
a claim to determine the user's country.

agent-desktop uses the npm archive from `registry.npmmirror.com` or
`registry.npmjs.org`. Both registries returned version 1.2.0 with the same official
SHA-512 integrity. The mirror archive was downloaded and independently verified:
15,285,285 bytes, SHA-256
`9e4b1a69d9d6be487873a1df8db61234a8b7a9c79aeced4e403a8126c0e0bcc0`.
Only the selected native executable and required platform helper are extracted;
package scripts and npm installation are not executed. The Windows executable matches
the previously verified GitHub release, so that installation can be reused.

Transport remains behind `backend::DriverId` and the agent-desktop adapter. A compatible
upstream MCP release usually needs a manifest update and contract regression checks.
Switching to FFI would replace that adapter and needs cancellation, lifecycle, window
targeting and cursor tests; it is not just a version-string change. The settings and
common tool entry do not need another parallel integration.

Targeted native validation: 55 tests passed, including the actual pinned Windows Cua DLL
and mirrored agent-desktop executable, recording/cancellation/restart, legacy migration,
storage relocation and persistence rollback, obsolete-version cleanup, corrupt-source
fallback, and platform helper verification. Non-Windows runtime validation and the full
PR/WDIO/coverage gates have not been rerun for this change.

Native app rehearsal also passed: both loaded drivers moved to a custom root, remained
available after restart, and moved back to the default root. The source's locked Cua DLL
was retired immediately and removed after a subsequent restart. Fresh installation from
the settings dropdown selected `registry.npmmirror.com`, completed download/activation
in about seven seconds and exposed 67 tools; Cua exposed 61 tools after relocation.
These are local Windows integration observations, not benchmark success-rate claims.

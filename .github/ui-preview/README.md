# UI Preview scripts

These scripts implement the advisory preview in `.github/workflows/ui-preview.yml`.

Every script is plain Node ESM with no dependencies, so the `plan`, `record`, and `publish` jobs do
not install the workspace to run them.

| File | Job | Purpose |
| --- | --- | --- |
| `detect.mjs` | `detect` | Decide, comment, emit outputs |
| `explore.mjs` | `explore` | Build facts on each platform: test ids, element outline, sections, overflow, locale parity |
| `plan.mjs` | `plan` | Model call and plan validation |
| `seed.mjs` | `record` | Fixture usage data for the throwaway app root |
| `record.mjs` | `record` | Execute the plan, capture native video and key screenshots |
| `publish.mjs` | `publish` | Validate every platform's evidence, scan for credentials, upload, update the comment |
| `doctor.mjs` | manual | Preflight the credentials |
| `with-display.sh` | `explore`, `record` | Window manager and compositor for Xvfb |
| `macos-display.swift` | `explore`, `record` | Select a 1920x1080 stage, falling back only when the runner cannot expose one |
| `configure-display.ps1` | `explore`, `record` | Select a 1920x1080 stage, falling back only when the runner cannot expose one |

`lib/` holds the pure logic. Repository workflow tests live in `tests/ci/ui-preview/` and run with:

```bash
pnpm test:ui-preview
```

`lib/evidence.mjs` holds the minimum duration, frame count, distinct states, and coverage that both
the recorder and the publisher enforce.

`lib/profile.mjs` keeps logical stage pixels, physical capture pixels, and the scale factor separate.
All three hosted workflows target a 1920x1080 stage at 1x. A helper falls back to another available
mode only when the runner cannot expose 1080p, and the publisher rejects a video whose dimensions do
not match the recorded physical stage, so a resized or upscaled clip cannot be published as
higher-resolution evidence.

The label-triggered `.github/workflows/ui-preview-native-validation.yml` re-runs native Linux,
macOS, and Windows capture and posts the comment as the App, using the same `BOT_APP_ID` and
`BOT_APP_PRIVATE_KEY` secrets as production. Use it to check a capture change before merge.

To check credentials, dispatch `.github/workflows/ui-preview.yml` with `mode: doctor`; no pull
request is needed.

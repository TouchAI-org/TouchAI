# UI Preview

Read this when changing `.github/workflows/ui-preview.yml`, `.github/ui-preview/**`, or the
preview comment a pull request receives.

## What it does

A pull request that changes desktop interface files gets one advisory comment with screenshots and
an mp4 of the built app. The comment is updated in place on every commit. It is not part of
`CI Required` and never blocks a merge.

## When it runs

The preview runs when at least one changed file can change what the desktop app renders:

```text
apps/desktop/src/views/**
apps/desktop/src/components/**
apps/desktop/src/styles/**
apps/desktop/src/i18n/**
apps/desktop/src/assets/**
apps/desktop/src/router/**
apps/desktop/index.html
apps/desktop/src-tauri/src/core/window/**
apps/desktop/src-tauri/tauri*.conf.json
```

Tests, docs, and the official site never trigger it, even inside those directories.

| Author | UI change | Result |
| --- | --- | --- |
| `admin`, `maintain`, or `write` | yes | Runs automatically |
| anyone else | yes | Waiting comment, nothing runs |
| anyone else, approved | yes | Runs on every later commit |
| any author, `status:ui-preview-skip` | any | Skipped, and the comment says so |

A maintainer approves by commenting `/ui-preview` on the pull request, or by adding
`status:ui-preview-approved`. The label is added automatically after a valid command so later
commits keep running. Removing the label revokes the approval. Draft pull requests wait for
`ready_for_review` unless a maintainer forces a run.

The workflow checks the actor who added `status:ui-preview-approved` or `ui-preview`. If a
non-maintainer adds either label, the run does not start and the label is removed, because the
triage role can also apply labels.

The `ui-preview` label forces a run, including on a pull request that only changed a composable.

## Trust model

The workflow is split so that no job both runs pull-request code and holds a secret.

| Job | Checks out | Secrets | Permissions |
| --- | --- | --- | --- |
| `detect` | default branch | App key | `contents: read` |
| `explore` | pull-request head | none | `contents: read` |
| `plan` | default branch | model key | `contents: read`, `pull-requests: read` |
| `record` | default branch | none | `contents: read` |
| `publish` | default branch | upload token, App key | `contents: read` |

`explore` is the only job that checks out the pull request, and it is the only job that builds it.
`record` runs the binary that `explore` produced, but drives it with scripts from the default
branch, so a pull request cannot change the recorder. `plan` and `publish` never execute
pull-request code.

## Pipeline

```text
detect   decide, comment, output pr/sha
explore  build once, boot under Xvfb, collect test ids, an element outline, locale parity
plan     interface-only diff + outline -> validated JSON scene plan
record   seed fixture data, run the plan, capture screenshots and mp4
publish  validate evidence, upload assets, update the comment
```

The model sees the diff of the interface files only, the description, the test ids, and an outline
of the rendered elements (test id, role, own text, below the fold). The diff is split per file
before it is cut, so a large pull request cannot push the interface files out of the window. Its
answer is data: every action is allowlisted, every click target must be a `data-testid` the build
actually rendered, and every string has a length cap. When the model is unavailable or its plan is
rejected, a deterministic plan for the changed surfaces is used instead.

A plan that only opens a window and takes one screenshot is rejected. Every scene needs at least
three interactions, the whole plan needs at least six interactions and three screenshots, and the
fallback plan types a query character by character, walks settings sections, toggles a control, and
scrolls a long list.

## Fixture data

A fresh install has no requests, so the Usage page records as a row of zeros and the model list is
empty. `record.mjs` boots the app once to create its database, quits, and runs `seed.mjs` against
`$TOUCHAI_APP_ROOT/data/touchai.db` before the recording boot.

`seed.mjs` inserts one provider, two models, six sessions, and about ninety turns over thirty days,
then rebuilds the daily rollups. It only inserts rows into existing tables: no schema change, no
migration, and nothing outside the throwaway app root. The sequence is fixed, so the same pull
request records the same numbers twice. A seeding failure is a warning in the manifest, not a
failed recording.

## Recording quality

The recording must show a flow, not a still image with a duration.

- Recording starts only after the first surface has painted, so the video has no black lead-in.
- Windows are opened before recording starts, so a blank webview never appears in the middle of a
  scene.
- The active window is moved below the title and the inactive window is unmapped. The search
  window hides itself when it loses focus, so position alone is not enough.
- The window is re-pinned after every step: the search window grows when results appear and the
  app recentres itself, which would otherwise slide it to the middle of the screen mid-clip.
- Opening a settings section resets the shared content scroll, so a section opened after a scroll
  does not start mid-page.
- ffmpeg captures at 10 fps and writes a constant 30 fps stream. Capturing 30 fps on a shared
  runner dropped most frames and produced a video much shorter than the session.
- Step captions are burned into a strip below the window, not drawn over the UI.
- The cursor draws a fading trail and a ring on each click, so a viewer can follow the path.
- A `shot` may name a `data-testid`; that screenshot is cropped to the element with room around it
  and a minimum size, instead of shrinking the whole window.
- Screenshots are captured by window id. Cropping the root by an earlier geometry produced black
  frames when the app recentred itself after a resize.

## Comment lifecycle

The single comment is rewritten three times at most: `waiting for a maintainer` before any build,
`recording` the moment a run starts, then the evidence. The recording note replaces the previous
commit's evidence, so a stale clip cannot be read as this commit's result.

## When a step fails

The recorder retries a failed step once and falls back to a DOM click, a DOM hover, or a window
scroll. A step that still fails is skipped, the rest of the scene and the following scenes still
run, and the comment lists every skipped step in a collapsed block. The recorder has no model key,
so it cannot ask for a new plan mid-run; a maintainer can pass one with the `plan_json` input of a
manual run.

Publishing re-checks the numbers and fails closed. A recording must be at least 6 seconds, at least
60 frames, at least 5 distinct visual states, and cover at least 80% of the recording session. A
missing `videoInfo` block is an error, not a pass. This is what stops a one-frame mp4 from being
published as evidence.

Publishing also refuses evidence that contains something shaped like a credential, and posts a
comment saying that nothing was published.

## Credentials

Publishing needs two credentials because GitHub's upload endpoint and comment API accept different
identity classes.

| Name | Kind | Used for |
| --- | --- | --- |
| `UI_PREVIEW_MODEL_API_KEY` | secret, `ui-preview` | the model call |
| `UI_PREVIEW_MODEL_BASE_URL`, `UI_PREVIEW_MODEL` | variables, `ui-preview` | endpoint and model |
| `ATTACHMENT_TOKEN` | secret, `ui-preview-publish` | `POST /user-attachments/assets` only |
| `BOT_APP_ID`, `BOT_APP_PRIVATE_KEY` | secrets, `ui-preview-publish` | the comment only |

The upload endpoint returns `404` for GitHub App installation tokens and for App user-to-server
tokens. It needs a token that belongs to a user with `admin`, `maintain` or `write` on the
repository. The comment endpoints accept an App installation token with `Issues: write` or
`Pull requests: write`. An upload has no author field, so the asset URL carries no attribution and
the comment carries the bot identity.

The video stays as a bare URL on its own line so GitHub renders its player. Screenshots use standard
Markdown image syntax and are collected into one collapsed block, so the media stays readable without
burying the rest of the pull request.

Both environments restrict deployments to protected branches, so only a workflow running from the
default branch can read them.

## The comment

There is exactly one comment per pull request, identified by `<!-- touchai-ui-preview -->` on its
first line. Publishing:

1. lists the pull-request comments;
2. keeps only comments whose author is the token's own account;
3. picks the oldest one that starts with the marker;
4. patches it, or creates one when none exists;
5. skips the write when the rendered body is identical.

Filtering on the author is required: a contributor can put the marker in their own comment, and the
API refuses an edit to a comment the token does not own. `gh pr comment --edit-last` is not used
because it edits the last comment by the token's account, which is not necessarily the preview.

The workflow passes `steps.app.outputs.app-slug` as `UI_PREVIEW_BOT_LOGIN`, so comment lookup does
not call `GET /user`. Installation tokens cannot use that endpoint. The scripts only fall back to
`GET /user` for local runs with a user token.

## Local verification

```bash
pnpm test:unit -- ui-preview
node .github/ui-preview/doctor.mjs --mode=model
node .github/ui-preview/doctor.mjs --mode=publish
```

The `UI Preview Doctor` workflow runs the same checks from Actions, where the secrets live: dispatch
it and read the two jobs. `doctor` proves the model endpoint, the bot identity, and the upload
credential, and names the credential class that failed. It never posts a comment. Run it after
rotating a secret and before the first preview on a real pull request.

The full recorder needs a Linux desktop stack: `xvfb`, `openbox`, `picom`, `ffmpeg`, `imagemagick`,
`xdotool`, `webkit2gtk-driver`, and `tauri-driver`.

## Failure behavior

A failed step is written to the manifest and published as `Recording stopped: <step>`. The comment
then shows the evidence that exists and states that it does not claim the change works. The
recording is never retried into a pass.

## Limitations

- Capture is Linux WebKitGTK only. Windows WebView2 and macOS may render differently.
- The desktop search and settings surfaces are covered. Tray and popup windows need test-only
  openers and get their own follow-up.
- Locale coverage is a static key-parity check, not a rendered comparison in both languages.
- Video is the whole 1280x900 virtual display; screenshots are captured from the active window.
- The desktop behind the window is black. This Xvfb and picom combination ignores a root colour,
  so a light background is not available without changing the compositor.

## Disabling

Add `status:ui-preview-skip` to the pull request. To stop the mechanism for the repository, disable
the `UI Preview` workflow; nothing else depends on it.

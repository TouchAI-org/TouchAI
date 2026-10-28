# UI Preview scripts

These scripts implement the advisory preview in `.github/workflows/ui-preview.yml`. The workflow
keeps pull-request code and credentials in separate jobs.

| File | Purpose |
| --- | --- |
| `detect.mjs` | Decide whether to run, comment, and emit outputs |
| `explore.mjs` | Build facts from the running app |
| `plan.mjs` | Build and validate the scene plan |
| `seed.mjs` | Fixture usage data for the throwaway app root |
| `record.mjs` | Execute the plan and capture screenshots plus an mp4 |
| `publish.mjs` | Validate evidence, upload it, and update the one comment |
| `doctor.mjs` | Check the model and publishing credentials |
| `with-display.sh` | Window manager and compositor for Xvfb |

`lib/` contains the reusable logic. Every script is plain Node ESM, so the preview jobs do not
install the workspace to run them.

To check credentials, dispatch the workflow with `mode: doctor`; no pull request is needed.

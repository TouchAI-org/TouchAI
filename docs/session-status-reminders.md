# Session Status Reminders

TouchAI now surfaces session status changes for `completed`, `failed`, and `waiting_approval`.

## Behavior

- When the TouchAI search window is visible in the foreground, the app shows a short in-app reminder overlay and does not send a Windows toast.
- When the app is in the background or hidden, the app sends one Windows system notification for the status change.
- Background reminders also increment a tray badge counter so missed status changes remain visible.
- Clicking a background status notification brings the user back to the TouchAI search surface.
- Returning to the TouchAI search surface clears the tray badge count and dismisses pending background status reminders.

## Covered states

- `completed`: the task finished successfully.
- `failed`: the task ended with an error.
- `waiting_approval`: the task is blocked until the user approves the next action.

## Notes

- These reminders are driven by existing session status transition signals.
- Windows notification activation for these reminders is handled through a native desktop path so notification clicks can restore the TouchAI window reliably.

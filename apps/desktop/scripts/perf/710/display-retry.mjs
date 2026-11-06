const DISPLAY_STARTUP_FAILURES = [
    'Dunst did not register org.freedesktop.Notifications',
    'Openbox did not become ready',
    'Cannot open X11 display',
    "Couldn't initialize X11 output",
    'X connection broke',
    'Trace/breakpoint trap',
];

export function shouldRetryDisplayStartupFailure({ runStarted, exitCode, signal, logText }) {
    if (runStarted) return false;
    if (exitCode === 0 && !signal) return false;
    return DISPLAY_STARTUP_FAILURES.some((signature) => logText.includes(signature));
}

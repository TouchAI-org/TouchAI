export function readComputerUseFeedbackAppearance() {
    const status = document.querySelector('[data-testid="computer-use-status"]');
    const stopKey = status?.querySelector('kbd');
    const pointer = document.querySelector('[data-testid="computer-use-pointer"]');
    const label = pointer?.querySelector('[data-pointer-label]');
    if (!status || !stopKey || !pointer || !label) return null;
    return {
        statusColor: getComputedStyle(status).color,
        stopKeyColor: getComputedStyle(stopKey).color,
        pointerLabelColor: getComputedStyle(label).color,
        pointerShadow: getComputedStyle(pointer).filter,
    };
}

export async function exerciseComputerUseGlow() {
    const invoke = window.__TAURI_INTERNALS__.invoke;
    const first = `glow-e2e-${crypto.randomUUID()}`;
    const second = `glow-e2e-${crypto.randomUUID()}`;
    const visible = () => invoke('plugin:window|is_visible', { label: 'computer-use-glow' });
    const focused = () => invoke('plugin:window|is_focused', { label: 'main' });
    const activity = (activityId, active) =>
        invoke('computer_use_glow_set_active', { activityId, active });
    const result = {};
    await invoke('plugin:window|show', { label: 'main' });
    await invoke('plugin:window|set_focus', { label: 'main' });
    try {
        result.focusedBefore = await focused();
        await activity(first, true);
        await new Promise((resolve) => setTimeout(resolve, 2200));
        result.visibleDuringPause = await visible();
        result.focusedDuringPause = await focused();
        await activity(second, true);
        await invoke('computer_use_glow_pulse', { activityId: first, pointer: { x: 240, y: 180 } });
        await invoke('computer_use_glow_pulse', {
            activityId: second,
            pointer: { x: 600, y: 400 },
        });
        const feedback = await invoke('computer_use_glow_snapshot');
        result.independentPointers =
            feedback.activities.filter((entry) => entry.pointer).length === 2;
        await activity(first, false);
        result.visibleWithSecondTask = await visible();
        const remaining = await invoke('computer_use_glow_snapshot');
        result.remainingIdentity =
            remaining.activities.length === 1 &&
            remaining.activities[0].id === second &&
            remaining.activities[0].ordinal === 2;
        await activity(second, false);
        result.visibleAfterCompletion = await visible();
        await invoke('computer_use_glow_pulse', { activityId: first, pointer: { x: 100, y: 100 } });
        result.visibleAfterLatePointer = await visible();
        await activity(first, true);
        await activity(second, true);
        await invoke('computer_use_cancel_all');
        result.stoppedAll = (await invoke('computer_use_glow_snapshot')).activities.length === 0;
        return result;
    } finally {
        await activity(first, false);
        await activity(second, false);
    }
}

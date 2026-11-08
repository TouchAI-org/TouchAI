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
    const hidden = async () => {
        const deadline = Date.now() + 1000;
        while (await visible()) {
            if (Date.now() >= deadline) return false;
            await new Promise((resolve) => setTimeout(resolve, 25));
        }
        return true;
    };
    const activity = (activityId, active) =>
        invoke('computer_use_glow_set_active', { activityId, active });
    const call = (activityId, tool, args) =>
        invoke('computer_use_invoke', {
            activityId,
            executionId: crypto.randomUUID(),
            driver: 'cua-driver',
            tool,
            arguments: { ...args, session: activityId },
            fullAccess: true,
            allowForeground: true,
        });
    const pause = (activityId, duration) =>
        call(activityId, 'run_script', {
            script: `await cua.sleep(${duration}); return 'fixture complete';`,
            timeout_ms: 5000,
        }).then(
            (value) => ({ value }),
            (error) => ({ error: String(error) })
        );
    const waitForActivity = async (id) => {
        const deadline = Date.now() + 5000;
        while (Date.now() < deadline) {
            const feedback = await invoke('computer_use_glow_snapshot');
            if (feedback.activities.some((entry) => entry.id === id) && (await visible())) return;
            await new Promise((resolve) => setTimeout(resolve, 25));
        }
        throw new Error('The foreground fixture did not become visible.');
    };
    const result = {};
    const pending = [];
    await invoke('plugin:window|show', { label: 'main' });
    await invoke('plugin:window|set_focus', { label: 'main' });
    try {
        result.focusedBefore = await focused();
        await activity(first, true);
        result.hiddenWhileWaiting = await hidden();
        const observation = await call(first, 'list_windows', {});
        if (observation.isError) throw new Error('The background observation failed.');
        result.hiddenAfterObservation = await hidden();
        await activity(second, true);
        const firstOperation = pause(first, 1500);
        pending.push(firstOperation);
        await waitForActivity(first);
        result.visibleDuringInput = await visible();
        result.focusedDuringInput = await focused();
        await invoke('computer_use_glow_pulse', { activityId: first, pointer: { x: 240, y: 180 } });
        const feedback = await invoke('computer_use_glow_snapshot');
        result.activePointer =
            feedback.activities.length === 1 && Boolean(feedback.activities[0].pointer);
        const firstResult = await firstOperation;
        if (firstResult.error || firstResult.value.isError)
            throw new Error('The first foreground fixture failed.');
        result.hiddenBetweenActions = await hidden();
        await invoke('computer_use_glow_pulse', { activityId: first, pointer: { x: 100, y: 100 } });
        result.hiddenAfterLatePointer = await hidden();
        const secondOperation = pause(second, 1500);
        pending.push(secondOperation);
        await waitForActivity(second);
        await invoke('computer_use_glow_pulse', {
            activityId: second,
            pointer: { x: 600, y: 400 },
        });
        const queuedOperation = pause(first, 500);
        pending.push(queuedOperation);
        const duringQueue = await invoke('computer_use_glow_snapshot');
        result.queuedTaskHidden = duringQueue.activities.every((entry) => entry.id === second);
        await activity(first, false);
        const queuedResult = await queuedOperation;
        result.queuedCallCancelled = Boolean(queuedResult.error?.includes('cancelled'));
        result.visibleWithSecondOperation = await visible();
        const remaining = await invoke('computer_use_glow_snapshot');
        result.remainingIdentity =
            remaining.activities.length === 1 &&
            remaining.activities[0].id === second &&
            remaining.activities[0].ordinal === 2;
        const secondResult = await secondOperation;
        if (secondResult.error || secondResult.value.isError)
            throw new Error('The second foreground fixture failed.');
        const failed = await call(second, 'run_script', {
            script: "throw new Error('fixture failure');",
        }).then(
            (value) => value.isError === true,
            (error) => String(error).includes('fixture failure')
        );
        if (!failed) throw new Error('The failing operation fixture did not report an error.');
        result.hiddenAfterFailure = await hidden();
        const cancelledOperation = pause(second, 4000);
        pending.push(cancelledOperation);
        await waitForActivity(second);
        await activity(second, false);
        await cancelledOperation;
        result.visibleAfterCompletion = !(await hidden());
        result.cancelledFeedback =
            (await invoke('computer_use_glow_snapshot')).activities.length === 0;
        return result;
    } finally {
        await activity(first, false);
        await activity(second, false);
        await Promise.all(pending);
    }
}

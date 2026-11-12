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
    const direct = `glow-direct-${crypto.randomUUID()}`;
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
            cursorVisible: true,
        });
    const pause = (activityId, duration, pointer) =>
        call(activityId, 'run_script', {
            script: `${pointer ? `await cua.call('move_cursor', ${JSON.stringify({ ...pointer, scope: 'desktop' })});` : ''} await cua.sleep(${duration}); return 'fixture complete';`,
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
    const originalPointer = await invoke('computer_use_cursor_position');
    const targetPointer = { x: originalPointer.x === 240 ? 260 : 240, y: 180 };
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
        const firstOperation = pause(first, 1500, targetPointer);
        pending.push(firstOperation);
        await waitForActivity(first);
        result.visibleDuringInput = await visible();
        result.focusedDuringInput = await focused();
        const origin = await invoke('plugin:window|inner_position', {
            label: 'computer-use-glow',
        });
        const scale = await invoke('plugin:window|scale_factor', { label: 'computer-use-glow' });
        const expectedPointer = {
            x: (targetPointer.x - origin.x) / scale,
            y: (targetPointer.y - origin.y) / scale,
        };
        const pointerDeadline = Date.now() + 1000;
        result.activePointer = false;
        while (Date.now() < pointerDeadline) {
            const feedback = await invoke('computer_use_glow_snapshot');
            const pointer = feedback.activities[0]?.pointer;
            if (
                feedback.activities.length === 1 &&
                pointer &&
                Math.abs(pointer.x - expectedPointer.x) < 1 &&
                Math.abs(pointer.y - expectedPointer.y) < 1
            ) {
                result.activePointer = true;
                break;
            }
            await new Promise((resolve) => setTimeout(resolve, 25));
        }
        const firstResult = await firstOperation;
        if (firstResult.error || firstResult.value.isError)
            throw new Error('The first foreground fixture failed.');
        result.visibleBetweenActions = await visible();
        await invoke('computer_use_glow_pulse', { activityId: first, pointer: { x: 100, y: 100 } });
        result.visibleAfterLatePointer = await visible();
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
        result.queuedTaskNoExtraFeedback =
            duringQueue.activities.length === 2 &&
            duringQueue.activities.every((entry) => entry.id === first || entry.id === second);
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
        result.visibleAfterFailure = await visible();
        const cancelledOperation = pause(second, 4000);
        pending.push(cancelledOperation);
        await waitForActivity(second);
        await activity(second, false);
        await cancelledOperation;
        result.visibleAfterCompletion = !(await hidden());
        result.cancelledFeedback =
            (await invoke('computer_use_glow_snapshot')).activities.length === 0;
        const directOperation = invoke('computer_use_invoke', {
            executionId: direct,
            driver: 'cua-driver',
            tool: 'run_script',
            arguments: { script: "await cua.sleep(4000); return 'direct fixture';" },
            fullAccess: true,
            allowForeground: true,
        }).then(
            (value) => ({ value }),
            (error) => ({ error: String(error) })
        );
        pending.push(directOperation);
        await waitForActivity(direct);
        await invoke('computer_use_cancel_all');
        const directResult = await directOperation;
        result.directCallStopped = Boolean(directResult.error || directResult.value.isError);
        result.hiddenAfterDirectCall = await hidden();
        return result;
    } finally {
        await activity(first, false);
        await activity(second, false);
        await invoke('computer_use_cancel', { executionId: direct });
        await Promise.all(pending);
        await invoke('computer_use_invoke', {
            executionId: crypto.randomUUID(),
            driver: 'cua-driver',
            tool: 'move_cursor',
            arguments: { ...originalPointer, scope: 'desktop' },
            fullAccess: true,
            allowForeground: true,
            cursorVisible: false,
        });
    }
}

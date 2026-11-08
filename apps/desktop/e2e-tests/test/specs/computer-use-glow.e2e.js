import {
    exerciseComputerUseGlow,
    readComputerUseFeedbackAppearance,
} from '../support/computer-use-glow.js';
import { assertVisible, switchToWindowContaining, waitForE2eBridge } from '../support/desktop.js';

describe('user runs computer control with activity feedback', () => {
    before(async () => {
        await waitForE2eBridge();
        await browser.execute(async () => {
            await window.__TAURI_INTERNALS__.invoke('computer_use_prepare', {
                driver: 'cua-driver',
            });
        });
    });

    it('user given computer tasks when executing foreground input then sees feedback only until that input ends', async () => {
        const result = await browser.execute(exerciseComputerUseGlow);
        assertVisible(result.focusedBefore, 'The foreground fixture was not focused.');
        assertVisible(result.hiddenWhileWaiting, 'Waiting for input displayed feedback.');
        assertVisible(result.hiddenAfterObservation, 'A background read displayed feedback.');
        assertVisible(result.visibleDuringInput, 'Foreground input did not display feedback.');
        assertVisible(result.focusedDuringInput, 'The activity glow took keyboard focus.');
        assertVisible(result.activePointer, 'The active input did not show its pointer.');
        assertVisible(
            result.hiddenBetweenActions,
            'Waiting between actions kept feedback visible.'
        );
        assertVisible(result.hiddenAfterLatePointer, 'A late pointer reopened feedback.');
        assertVisible(
            result.queuedTaskHidden,
            'A queued task displayed feedback before execution.'
        );
        assertVisible(
            result.queuedCallCancelled,
            'Cancelling a queued task did not prevent input.'
        );
        assertVisible(result.visibleWithSecondOperation, 'Ending an idle task hid active input.');
        assertVisible(result.remainingIdentity, 'The remaining session lost its identity.');
        assertVisible(result.hiddenAfterFailure, 'A failed operation left feedback visible.');
        assertVisible(result.cancelledFeedback, 'Cancelled input left feedback visible.');
        assertVisible(
            !result.visibleAfterCompletion,
            'The activity glow remained after completion.'
        );
    });

    it('user given active computer control when feedback appears then reads white status text and pointer labels', async () => {
        const mainWindow = await browser.getWindowHandle();
        const activityId = 'glow-appearance-e2e';
        try {
            await browser.execute(async (id) => {
                await window.__TAURI_INTERNALS__.invoke('computer_use_glow_set_active', {
                    activityId: id,
                    active: true,
                });
                window.__computerUseAppearance = window.__TAURI_INTERNALS__
                    .invoke('computer_use_invoke', {
                        activityId: id,
                        executionId: id,
                        driver: 'cua-driver',
                        fullAccess: true,
                        allowForeground: true,
                        tool: 'run_script',
                        arguments: {
                            script: "await cua.sleep(10000); return 'appearance fixture';",
                            session: id,
                        },
                    })
                    .catch(() => undefined);
                const deadline = Date.now() + 5000;
                while (Date.now() < deadline) {
                    const feedback = await window.__TAURI_INTERNALS__.invoke(
                        'computer_use_glow_snapshot'
                    );
                    if (feedback.activities.some((entry) => entry.id === id)) break;
                    await new Promise((resolve) => setTimeout(resolve, 25));
                }
                await window.__TAURI_INTERNALS__.invoke('computer_use_glow_pulse', {
                    activityId: id,
                    pointer: { x: 240, y: 180 },
                });
            }, activityId);
            await switchToWindowContaining('/computer-use-glow');
            await browser.waitUntil(
                async () => Boolean(await browser.execute(readComputerUseFeedbackAppearance)),
                { timeoutMsg: 'Computer-control status and pointer did not render.' }
            );
            const appearance = await browser.execute(readComputerUseFeedbackAppearance);
            for (const color of [
                appearance.statusColor,
                appearance.stopKeyColor,
                appearance.pointerLabelColor,
            ]) {
                assertVisible(
                    color === 'rgb(255, 255, 255)',
                    `Expected white feedback text, got ${color}.`
                );
            }
            assertVisible(appearance.pointerShadow !== 'none', 'The pointer shadow disappeared.');
        } finally {
            await browser.switchToWindow(mainWindow);
            await browser.execute(async (id) => {
                await window.__TAURI_INTERNALS__.invoke('computer_use_glow_set_active', {
                    activityId: id,
                    active: false,
                });
                await window.__computerUseAppearance;
                delete window.__computerUseAppearance;
            }, activityId);
        }
    });
});

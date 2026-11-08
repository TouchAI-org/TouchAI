import {
    exerciseComputerUseGlow,
    readComputerUseFeedbackAppearance,
} from '../support/computer-use-glow.js';
import { assertVisible, switchToWindowContaining, waitForE2eBridge } from '../support/desktop.js';

describe('user runs computer control with activity feedback', () => {
    before(async () => {
        await waitForE2eBridge();
    });

    it('user given active computer tasks when pausing and finishing then keeps focus and sees feedback until the last task ends', async () => {
        const result = await browser.execute(exerciseComputerUseGlow);
        assertVisible(result.focusedBefore, 'The foreground fixture was not focused.');
        assertVisible(result.visibleDuringPause, 'The activity glow disappeared during the task.');
        assertVisible(result.focusedDuringPause, 'The activity glow took keyboard focus.');
        assertVisible(result.visibleWithSecondTask, 'Ending one task hid another active task.');
        assertVisible(
            result.independentPointers,
            'Concurrent sessions overwrote each other’s pointer.'
        );
        assertVisible(result.remainingIdentity, 'The remaining session lost its identity.');
        assertVisible(result.stoppedAll, 'Stopping control left a session active.');
        assertVisible(
            !result.visibleAfterCompletion,
            'The activity glow remained after completion.'
        );
        assertVisible(
            !result.visibleAfterLatePointer,
            'A late pointer reopened the activity glow.'
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
            }, activityId);
        }
    });
});

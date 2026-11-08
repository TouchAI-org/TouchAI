import { exerciseComputerUseGlow } from '../support/computer-use-glow.js';
import { assertVisible, waitForE2eBridge } from '../support/desktop.js';

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
});

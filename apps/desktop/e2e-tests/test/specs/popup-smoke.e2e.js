import {
    closePopupsAndReturn,
    expectDisplayedByTestId,
    openPopupWindowFromMain,
} from '../support/windows.js';

async function waitForEitherDisplayed(testIds) {
    await browser.waitUntil(
        async () => {
            for (const testId of testIds) {
                const element = await $(`[data-testid='${testId}']`);
                if (await element.isDisplayed().catch(() => false)) {
                    return true;
                }
            }
            return false;
        },
        {
            timeout: 30000,
            timeoutMsg: `Expected one of these test ids to be displayed: ${testIds.join(', ')}`,
        }
    );
}

describe('TouchAI popup smoke', () => {
    it('opens the model dropdown popup through the registered popup window', async () => {
        const { mainWindowHandle } = await openPopupWindowFromMain(
            'model-dropdown-popup',
            'openModelDropdownPopup',
            'model-dropdown-popup'
        );

        try {
            await expectDisplayedByTestId('model-dropdown-popup');
            await expectDisplayedByTestId('model-dropdown-search-input');
            await waitForEitherDisplayed(['model-dropdown-option', 'model-dropdown-empty']);
        } finally {
            await closePopupsAndReturn(mainWindowHandle);
        }
    });

    it('opens the session history popup through the registered popup window', async () => {
        const { mainWindowHandle } = await openPopupWindowFromMain(
            'session-history-popup',
            'openSessionHistoryPopup',
            'session-history-popup'
        );

        try {
            await expectDisplayedByTestId('session-history-popup');
            await expectDisplayedByTestId('session-history-search-input');
            await waitForEitherDisplayed([
                'session-history-item',
                'session-history-empty',
                'session-history-loading',
            ]);
        } finally {
            await closePopupsAndReturn(mainWindowHandle);
        }
    });
});

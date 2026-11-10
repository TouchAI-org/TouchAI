import {
    callE2eBridge,
    resetSearchSurface,
    useProductFont,
    waitForE2eBridge,
    waitForTestIdDisplayed,
} from '../support/desktop.js';
import { assertGridResultTextFits, measureGridResultText } from '../support/result-text.js';

const QUERY = '你好 grid-text-fixture';
const FILENAMES = ['你好星期日.png', 'typography gyp.png'];

describe('given two-line file names use the product typeface in the result grid', () => {
    before(async () => {
        await waitForE2eBridge();
        await useProductFont();
    });

    afterEach(resetSearchSurface);

    it('user when viewing Chinese names and Latin descenders then sees both complete lines', async () => {
        await resetSearchSurface();
        await callE2eBridge(
            'setSearchFixture',
            QUERY,
            Array.from({ length: 7 }, (_, index) => ({
                name: FILENAMES[index % FILENAMES.length],
                path: `C:/TouchAI/text-layout-fixture/${index}.png`,
                source: 'file',
            }))
        );
        await callE2eBridge('setSearchQuery', QUERY);
        const panel = await waitForTestIdDisplayed('quick-search-panel');
        if (!(await panel.$('.quick-search-grid').isExisting())) {
            await panel.$('[data-testid="quick-search-view-toggle"]').click();
        }
        await browser.waitUntil(
            () =>
                browser.execute(() => {
                    const card = document.querySelector('[data-testid="search-view-card"]');
                    const panel = document.querySelector('[data-testid="quick-search-panel"]');
                    return (
                        document.querySelectorAll('.quick-search-grid button').length === 7 &&
                        card.getAnimations().length === 0 &&
                        panel.getBoundingClientRect().bottom <= card.getBoundingClientRect().bottom
                    );
                }),
            { timeoutMsg: 'The fixture files did not appear in grid layout.' }
        );
        await browser.execute(async () => {
            await document.fonts.ready;
            await new Promise((resolve) =>
                requestAnimationFrame(() => requestAnimationFrame(resolve))
            );
        });
        assertGridResultTextFits(
            await browser.execute(measureGridResultText, FILENAMES),
            FILENAMES
        );
    });
});

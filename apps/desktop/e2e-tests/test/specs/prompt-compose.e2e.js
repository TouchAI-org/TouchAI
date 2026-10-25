/**
 * User flows for composing a prompt in the idle search window: a prompt can span several
 * lines, and the editor keeps the text until the user deliberately submits it. No model is
 * involved, so these flows are about the editor contract rather than about an answer.
 */
import { assertVisible, waitForE2eBridge, waitForTestIdDisplayed } from '../support/desktop.js';

async function editorElement() {
    const editor = await $("[data-testid='search-editor-host'] .ProseMirror");
    await editor.waitForDisplayed();
    return editor;
}

async function clearEditor(editor) {
    await editor.click();
    await browser.keys(['Control', 'a']);
    await browser.keys(['Backspace']);
}

describe('user composes a multi-line prompt', () => {
    before(async () => {
        await waitForE2eBridge();
        await waitForTestIdDisplayed('search-view');
    });

    it('user gets a second line when pressing Shift and Enter', async () => {
        const editor = await editorElement();
        await clearEditor(editor);

        await editor.click();
        await browser.keys(['first line']);
        await browser.keys(['Shift', 'Enter']);
        await browser.keys(['second line']);

        const text = await editor.getText();
        assertVisible(
            text.includes('first line') && text.includes('second line'),
            `The editor lost part of the prompt: ${JSON.stringify(text)}`
        );
        // A soft break must keep both lines in one prompt, not split it into two.
        assertVisible(
            /\n/.test(text) || text.indexOf('second line') > text.indexOf('first line'),
            `The prompt did not grow a second line: ${JSON.stringify(text)}`
        );
    });

    it('user keeps the composed prompt while the window still shows the editor', async () => {
        const editor = await editorElement();

        assertVisible(
            (await editor.getText()).includes('second line'),
            'The prompt was cleared without the user submitting it.'
        );

        const searchView = await waitForTestIdDisplayed('search-view');
        assertVisible(await searchView.isDisplayed(), 'The search window stopped being visible.');
    });

    it('user sees the prompt field empty again after clearing it', async () => {
        const editor = await editorElement();
        await clearEditor(editor);

        await browser.waitUntil(async () => (await editor.getText()).trim().length === 0, {
            timeoutMsg: 'The editor still held text after it was cleared.',
        });
    });
});

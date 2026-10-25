/**
 * User flows for pasting into the prompt. The renderer asks the Rust clipboard runtime for a
 * structured payload, so these flows are the only end-to-end evidence that the native side
 * hands back something the editor can use.
 */
import { assertVisible, waitForE2eBridge, waitForTestIdDisplayed } from '../support/desktop.js';

async function editorElement() {
    const editor = await $("[data-testid='search-editor-host'] .ProseMirror");
    await editor.waitForDisplayed();
    return editor;
}

async function writeClipboardText(text) {
    // Put known content on the OS clipboard through the app's own command, so the paste path
    // reads what the test wrote rather than whatever the machine happened to hold.
    await browser.executeAsync((value, done) => {
        const invoke = window.__TAURI_INTERNALS__?.invoke;
        if (typeof invoke !== 'function') {
            done({ ok: false, error: 'Tauri invoke is not available' });
            return;
        }
        invoke('write_clipboard_text', { text: value })
            .then(() => done({ ok: true }))
            .catch((error) => done({ ok: false, error: String(error) }));
    }, text);
}

async function clearEditor(editor) {
    await editor.click();
    await browser.keys(['Control', 'a']);
    await browser.keys(['Backspace']);
}

describe('user pastes into the prompt', () => {
    before(async () => {
        await waitForE2eBridge();
        await waitForTestIdDisplayed('search-view');
    });

    it('user gets the pasted text inserted into the prompt field', async () => {
        const editor = await editorElement();
        await clearEditor(editor);
        await writeClipboardText('pasted-from-the-clipboard');

        await editor.click();
        await browser.keys(['Control', 'v']);

        await browser.waitUntil(
            async () => (await editor.getText()).includes('pasted-from-the-clipboard'),
            { timeoutMsg: 'The pasted text did not reach the editor.' }
        );
    });

    it('user keeps the prompt usable after pasting', async () => {
        const editor = await editorElement();
        const searchView = await waitForTestIdDisplayed('search-view');

        assertVisible(
            await editor.isDisplayed(),
            'The prompt field stopped being visible after a paste.'
        );
        assertVisible(
            await searchView.isDisplayed(),
            'The search window stopped being visible after a paste.'
        );
    });

    it('user gets the pasted text replaced when pasting over a selection', async () => {
        const editor = await editorElement();
        await clearEditor(editor);
        await editor.click();
        await browser.keys(['original-text']);
        await browser.keys(['Control', 'a']);
        await writeClipboardText('replacement-text');

        await browser.keys(['Control', 'v']);

        await browser.waitUntil(
            async () => {
                const text = await editor.getText();
                return text.includes('replacement-text') && !text.includes('original-text');
            },
            { timeoutMsg: 'Pasting over a selection did not replace the text.' }
        );
    });

    after(async () => {
        const editor = await editorElement();
        await clearEditor(editor);
    });
});

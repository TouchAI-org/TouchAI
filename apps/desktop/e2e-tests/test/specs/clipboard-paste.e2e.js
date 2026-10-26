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
    const result = await browser.execute(async (value) => {
        const invoke = window.__TAURI_INTERNALS__?.invoke;
        if (typeof invoke !== 'function') {
            return { ok: false, error: 'Tauri invoke is not available' };
        }

        try {
            await invoke('write_clipboard_text', { text: value });
            return { ok: true };
        } catch (error) {
            return { ok: false, error: String(error) };
        }
    }, text);

    if (!result || result.ok !== true) {
        // Fail here, with the real reason, instead of letting the paste time out later and
        // looking like an editor problem.
        throw new Error(
            `Could not seed the clipboard: ${(result && result.error) || 'unknown error'}`
        );
    }
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

    it('user pastes and gets the text inserted into the prompt field', async () => {
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

    it('user types after pasting and gets the keystrokes in the prompt', async () => {
        const editor = await editorElement();
        await clearEditor(editor);
        await writeClipboardText('pasted-then-typed');

        await editor.click();
        await browser.keys(['Control', 'v']);
        await browser.waitUntil(
            async () => (await editor.getText()).includes('pasted-then-typed'),
            { timeoutMsg: 'The pasted text did not reach the editor.' }
        );

        // An editor that is merely visible can still have stopped accepting input, so type.
        await browser.keys(['-typed-marker']);
        await browser.waitUntil(async () => (await editor.getText()).includes('-typed-marker'), {
            timeoutMsg: 'The editor did not accept typing after a paste.',
        });

        const searchView = await waitForTestIdDisplayed('search-view');
        assertVisible(
            await searchView.isDisplayed(),
            'The search window stopped being visible after typing.'
        );
    });

    it('user pastes over a selection and gets the selected text replaced', async () => {
        const editor = await editorElement();
        await clearEditor(editor);
        await editor.click();
        await browser.keys(['original-text']);

        // Prove the original landed first, otherwise the replacement assertion can pass on an
        // editor that never held anything.
        await browser.waitUntil(async () => (await editor.getText()).includes('original-text'), {
            timeoutMsg: 'The original text never reached the editor.',
        });

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

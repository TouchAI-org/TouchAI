/**
 * User flows for path-based file and folder references.
 *
 * These flows deliberately use a real temporary directory instead of the E2E
 * search fixture: the directory command, plugin-fs stat and attachment creation
 * all cross the native boundary, and a synthetic fixture would bypass exactly the
 * behavior this spec exists to prove.
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import {
    assertVisible,
    resetSearchSurface,
    waitForE2eBridge,
    waitForTestIdDisplayed,
} from '../support/desktop.js';

let fixtureRoot;
let directoryPath;
let filePath;
let folderPath;

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

async function writeClipboardText(text) {
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
        throw new Error(
            `Could not seed the clipboard: ${(result && result.error) || 'unknown error'}`
        );
    }
}

function toTypedPath(value) {
    // Keep the request independent of Windows key escaping; the native resolver
    // accepts both separators.
    return value.replaceAll('\\', '/');
}

async function typeDirectoryQuery(query) {
    const editor = await editorElement();
    await editor.click();
    await browser.keys([`@${query}`]);
    await waitForTestIdDisplayed('quick-search-panel');
    await browser.waitUntil(
        async () => (await $$('[data-testid="quick-search-panel"] [role="option"]')).length > 0,
        { timeoutMsg: 'The @ directory query did not render its real directory entries.' }
    );
}

async function optionLabels() {
    const options = await $$('[data-testid="quick-search-panel"] [role="option"]');
    return Promise.all(options.map((option) => option.getText()));
}

describe('given a user references paths on disk', () => {
    before(async () => {
        await waitForE2eBridge();
        await waitForTestIdDisplayed('search-view');

        fixtureRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'touchai-e2e-path-'));
        directoryPath = fixtureRoot;
        folderPath = path.join(fixtureRoot, 'project');
        filePath = path.join(fixtureRoot, 'notes.md');
        fs.mkdirSync(folderPath, { recursive: true });
        fs.writeFileSync(filePath, '# Notes\n');
        fs.writeFileSync(path.join(fixtureRoot, 'plan.txt'), 'plan\n');
    });

    beforeEach(resetSearchSurface);
    afterEach(resetSearchSurface);

    after(() => {
        if (fixtureRoot) fs.rmSync(fixtureRoot, { recursive: true, force: true });
    });

    it('user typing a directory path sees its direct files and folders, not fuzzy results', async () => {
        const typedDirectory = toTypedPath(directoryPath);
        await typeDirectoryQuery(`${typedDirectory}/`);

        const labels = await optionLabels();
        assertVisible(
            labels.length === 3,
            `Expected exactly the directory entries, got ${labels.length}.`
        );
        assertVisible(
            labels.some((label) => label.includes('project')) &&
                labels.some((label) => label.includes('notes.md')) &&
                labels.some((label) => label.includes('plan.txt')),
            `Expected the real directory entries, got ${JSON.stringify(labels)}.`
        );
        assertVisible(
            labels[0].includes('project'),
            'Directories must be listed before files so the user can keep browsing.'
        );
    });

    it('user referencing the directory result inserts a folder tag', async () => {
        const typedDirectory = toTypedPath(directoryPath);
        await typeDirectoryQuery(`${typedDirectory}/`);
        await browser.keys(['ArrowDown']);
        await browser.keys(['Tab']);

        await browser.waitUntil(
            async () => (await $('[data-attachment-tag]').getText()).includes('project'),
            { timeoutMsg: 'The folder reference tag did not keep its directory name.' }
        );
    });

    it('user typing an exact file path inserts that file reference', async () => {
        const typedFile = toTypedPath(filePath);
        await typeDirectoryQuery(typedFile);

        const labels = await optionLabels();
        assertVisible(
            labels.length === 1 && labels[0].includes('notes.md'),
            `An exact file path must yield one row, got ${JSON.stringify(labels)}.`
        );
        await browser.keys(['ArrowDown']);
        await browser.keys(['Tab']);
        await browser.waitUntil(() => $('[data-attachment-tag]').isExisting());
        await browser.waitUntil(
            async () => (await $('[data-attachment-tag]').getText()).includes('notes.md'),
            { timeoutMsg: 'The exact file reference tag did not keep its file name.' }
        );
    });

    it('user pasting an existing file path gets a tag instead of raw text', async () => {
        const editor = await editorElement();
        await clearEditor(editor);
        await writeClipboardText(`"${filePath}"`);

        await editor.click();
        await browser.keys(['Control', 'v']);

        await browser.waitUntil(() => $('[data-attachment-tag]').isExisting(), {
            timeoutMsg: 'Pasting an existing file path did not create an attachment tag.',
        });
        await browser.waitUntil(
            async () => (await $('[data-attachment-tag]').getText()).includes('notes.md'),
            { timeoutMsg: 'The pasted file tag did not keep its file name.' }
        );
        assertVisible(
            !(await editor.getText()).includes(filePath),
            'The raw path must not remain as prose after it became a tag.'
        );
    });

    it('user pasting an existing directory path gets a folder tag', async () => {
        const editor = await editorElement();
        await clearEditor(editor);
        await writeClipboardText(folderPath);

        await editor.click();
        await browser.keys(['Control', 'v']);

        await browser.waitUntil(() => $('[data-attachment-tag]').isExisting(), {
            timeoutMsg: 'Pasting an existing directory path did not create a folder tag.',
        });
        await browser.waitUntil(
            async () => (await $('[data-attachment-tag]').getText()).includes('project'),
            { timeoutMsg: 'The pasted folder tag did not keep its folder name.' }
        );
    });

    it('user pasting a missing path keeps it as plain text', async () => {
        const editor = await editorElement();
        await clearEditor(editor);
        const missingPath = path.join(fixtureRoot, 'missing-file.txt');
        await writeClipboardText(missingPath);

        await editor.click();
        await browser.keys(['Control', 'v']);

        await browser.waitUntil(async () => (await editor.getText()).includes('missing-file.txt'), {
            timeoutMsg: 'A missing path must remain as plain text.',
        });
        assertVisible(
            !(await $('[data-attachment-tag]').isExisting()),
            'A missing path must not create an attachment tag.'
        );
    });
});

import { getAgentFixture } from './agent-fixture.js';
import { callE2eBridge } from './desktop.js';

export async function focusMain() {
    await browser.execute(async () => {
        await window.__TAURI_INTERNALS__.invoke('plugin:window|set_focus', { label: 'main' });
    });
    await browser.waitUntil(() => browser.execute(() => document.hasFocus()));
}

/** Submit without awaiting the turn: a human must still be able to answer approvals. */
export async function submitPrompt(prompt) {
    await focusMain();
    await callE2eBridge('setSearchQuery', prompt);
    const editor = await $('[data-testid="search-editor-host"] .ProseMirror');
    await editor.waitForDisplayed();
    await editor.click();
    await browser.keys('Enter');
}

export async function waitForAnswer(text) {
    await browser.waitUntil(
        () => browser.execute((value) => document.body.innerText.includes(value), text),
        { timeout: 30000, timeoutMsg: `The user did not see ${text}` }
    );
}

export async function waitForTurn(status = 'completed') {
    await browser.waitUntil(
        () =>
            getAgentFixture().query('SELECT status FROM session_turns ORDER BY id DESC LIMIT 1')[0]
                ?.status === status,
        { timeout: 20000, timeoutMsg: `The latest turn was not durably ${status}` }
    );
    // The database commits before the renderer has applied the terminal projection.
    await $(
        '[data-testid="conversation-panel-host"] [role="log"][aria-busy="false"]'
    ).waitForExist();
}

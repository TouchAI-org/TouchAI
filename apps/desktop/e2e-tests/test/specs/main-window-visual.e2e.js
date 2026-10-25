/**
 * User flows: the main window in the states a person actually meets.
 *
 * The first spec only covers the empty search window, which is the least
 * interesting screen in the app: once a conversation starts, the window grows and
 * the layout is completely different. These baselines capture those states so a
 * token or spacing change in the conversation panel, the search results or the
 * ask-user panel shows up as an image diff instead of reaching a user.
 *
 * The transcript and the pending request come from the app's E2E bridge. A real
 * model call would make the pixels depend on a network response, and the point of
 * a baseline is that a difference means the code changed.
 */
import {
    assertVisible,
    callE2eBridge,
    useInterfaceLanguage,
    useProductFont,
    visualMismatchTolerance,
    waitForE2eBridge,
    waitForTestIdDisplayed,
    waitForTestIdNotDisplayed,
} from '../support/desktop.js';

const ASSISTANT_ANSWER = [
    'The migration replaced bespoke scanners with standard tooling:',
    '',
    '1. Tokens moved into `@theme`, so colour, radius and type come from one place.',
    '2. Lint rules now reject arbitrary values and palette utilities in new code.',
    '3. Visual baselines record the main window and the settings screens.',
].join('\n');

/**
 * A finished exchange, shaped exactly like the app's own `SessionMessage`.
 *
 * `parts` is the source of truth for what the panel renders — `content` alone is
 * not enough — so both are filled in. Getting this wrong produces a message bubble
 * with its toolbar but no text, which is a bug the baseline would happily record.
 */
const CONVERSATION_FIXTURE = [
    {
        id: 'e2e-user-1',
        role: 'user',
        content: 'Summarize the design system migration in three bullet points.',
        parts: [
            {
                id: 'e2e-user-1-part-1',
                type: 'text',
                content: 'Summarize the design system migration in three bullet points.',
            },
        ],
        timestamp: 1_760_000_000_000,
    },
    {
        id: 'e2e-assistant-1',
        role: 'assistant',
        content: ASSISTANT_ANSWER,
        parts: [
            {
                id: 'e2e-assistant-1-part-1',
                type: 'text',
                content: ASSISTANT_ANSWER,
            },
        ],
        timestamp: 1_760_000_001_000,
    },
];

describe('user works in the main window with a conversation', () => {
    before(async () => {
        await waitForE2eBridge();
        await useInterfaceLanguage();
        await useProductFont();
    });

    after(async () => {
        // The specs run in one session, and this one leaves a transcript and a
        // pending approval behind. Clearing both, and shrinking the window back,
        // is what keeps the search spec that follows independent.
        await callE2eBridge('setConversationFixture', []);
        await callE2eBridge('clearAskUserFixture');
        await browser.execute(() => window.__TOUCHAI_E2E__?.setSearchQuery?.(''));
        await browser.setWindowSize(750, 60);
        await browser.pause(500);
    });

    it('user sees the search results panel keep its layout while typing', async () => {
        await browser.setWindowSize(750, 80);
        // A query no real file matches: the bridge answers for it, so the pixels do
        // not depend on what happens to be on this machine's disk.
        await browser.execute(() =>
            window.__TOUCHAI_E2E__.setSearchQuery('touchai-visual-fixture')
        );

        const panel = await waitForTestIdDisplayed('quick-search-panel');
        await browser.pause(700);

        assertVisible(await panel.isDisplayed(), 'The results panel was not visible.');
        await expect(browser).toMatchScreenSnapshot(
            'main-window-search-results',
            await visualMismatchTolerance()
        );

        await browser.execute(() => window.__TOUCHAI_E2E__.setSearchQuery(''));
        await waitForTestIdNotDisplayed('quick-search-panel');
    });

    it('user sees the conversation panel with a finished answer', async () => {
        await callE2eBridge('setConversationFixture', CONVERSATION_FIXTURE);

        // The window grows to fit the conversation, so it is resized first and the
        // element is queried afterwards: a handle taken before the reflow goes stale
        // and `getBoundingClientRect` fails.
        await browser.setWindowSize(750, 620);
        await waitForTestIdDisplayed('conversation-panel-host');
        await browser.pause(1200);

        await expect(browser).toMatchScreenSnapshot(
            'main-window-conversation',
            await visualMismatchTolerance()
        );
    });

    it('user sees the ask-user panel when a tool needs a decision', async () => {
        await callE2eBridge('setAskUserFixture', {
            kind: 'approval',
            title: 'Run a shell command',
            description: 'The agent wants to list the files in the current directory.',
            command: 'ls -la',
            riskLabel: 'Low risk',
            reason: 'Read-only command that only prints file names.',
            commandLabel: 'Command',
            approveLabel: 'Run',
            rejectLabel: 'Cancel',
            enterHint: 'Enter to run',
            escHint: 'Esc to cancel',
        });

        await browser.setWindowSize(750, 520);
        const panel = await waitForTestIdDisplayed('ask-user-panel');
        await browser.pause(800);

        assertVisible(await panel.isDisplayed(), 'The ask-user panel was not visible.');
        await expect(browser).toMatchScreenSnapshot(
            'main-window-ask-user',
            await visualMismatchTolerance()
        );
    });
});

import { describe, expect, it } from 'vitest';

import {
    contentWindowFrame,
    conversationCheck,
    SEARCH_CONVERSATION_NOT_VISIBLE_MESSAGE,
    SEARCH_CONVERSATION_REQUIRED_MESSAGE,
    SEARCH_WINDOW_IDLE_HEIGHT,
    SEARCH_WINDOW_RESULTS_HEIGHT,
    SEARCH_WINDOW_WIDTH,
    searchContentState,
    searchWindowFrame,
    SETTINGS_WINDOW_CONTENT_HEIGHT,
    SETTINGS_WINDOW_CONTENT_WIDTH,
    SETTINGS_WINDOW_HEIGHT,
    SETTINGS_WINDOW_WIDTH,
    WINDOW_SHADOW_GUTTER,
} from '../../../.github/ui-preview/lib/profile.mjs';

const stage = { width: 1920, height: 1080 };

function parseDocument(html) {
    const testIds = new Map();

    for (const match of html.matchAll(/data-testid="([^"]+)"([^>]*)>/g)) {
        const attributes = match[2];
        const style = /style="([^"]*)"/.exec(attributes)?.[1] ?? '';
        const height = Number(/\bdata-height="(\d+)"/.exec(attributes)?.[1] ?? 420);

        testIds.set(match[1], { style, height });
    }

    const viewport = { width: 1280, height: 900 };
    const style = (element) => {
        const match = testIds.get(element.testId);
        const declarations = new Map(
            (match?.style ?? '')
                .split(';')
                .map((declaration) => declaration.split(':').map((part) => part.trim()))
                .filter(([property, value]) => property && value)
        );

        return {
            display: declarations.get('display') ?? '',
            visibility: declarations.get('visibility') ?? '',
            opacity: declarations.get('opacity') ?? '1',
        };
    };
    const element = (testId) => {
        const match = testIds.get(testId);

        if (!match) {
            return null;
        }

        const rect = {
            left: 0,
            top: 0,
            right: 750,
            bottom: match.height,
            width: 750,
            height: match.height,
        };

        return {
            testId,
            getBoundingClientRect: () => rect,
            getClientRects: () => [{}],
            scrollHeight: match.height,
            closest: () => null,
            style: { display: match.display === 'none' ? 'none' : '' },
            querySelectorAll: (selector) => {
                if (selector === '[data-message-role]') {
                    return [...html.matchAll(/data-message-role="([^"]+)"/g)].map((entry) => ({
                        role: entry[1],
                        getBoundingClientRect: () => rect,
                    }));
                }
                if (selector === "[data-message-role='user']") {
                    return [...html.matchAll(/data-message-role="([^"]+)"/g)]
                        .filter((entry) => entry[1] === 'user')
                        .map(() => ({ getBoundingClientRect: () => rect }));
                }
                if (selector === '[data-request-status]') {
                    return html.includes('data-request-status')
                        ? [{ getBoundingClientRect: () => rect }]
                        : [];
                }
                return [];
            },
        };
    };

    return {
        defaultView: {
            innerWidth: viewport.width,
            innerHeight: viewport.height,
            getComputedStyle: style,
        },
        documentElement: { clientWidth: viewport.width, clientHeight: viewport.height },
        querySelector(selector) {
            const testId = /\[data-testid=['"]([^'"]+)['"]\]/.exec(selector)?.[1];

            return testId ? element(testId) : null;
        },
    };
}

describe('user reviews an empty search window', () => {
    it('user sees the compact bar instead of an empty results frame', () => {
        const frame = searchWindowFrame(stage);

        expect(frame).toEqual({
            width: SEARCH_WINDOW_WIDTH,
            height: SEARCH_WINDOW_IDLE_HEIGHT,
            x: 585,
            y: 510,
        });
    });
});

describe('user reviews search results', () => {
    it('user sees one expanded frame that keeps the same center', () => {
        const compact = searchWindowFrame(stage);
        const expanded = searchWindowFrame(stage, { expanded: true });

        expect(expanded.width).toBe(SEARCH_WINDOW_WIDTH);
        expect(expanded.height).toBe(SEARCH_WINDOW_RESULTS_HEIGHT);
        expect(expanded.x).toBe(compact.x);
        expect(expanded.y + expanded.height / 2).toBe(compact.y + compact.height / 2);
    });

    it('user sees the results frame fit its content instead of leaving a blank area', () => {
        const frame = searchWindowFrame(stage, { expanded: true, contentHeight: 207 });

        expect(frame.height).toBe(207);
        expect(frame.y).toBe(437);
    });

    it('user never gets a results frame taller than the stable maximum', () => {
        const frame = searchWindowFrame(stage, { expanded: true, contentHeight: 900 });

        expect(frame.height).toBe(SEARCH_WINDOW_RESULTS_HEIGHT);
    });

    it('user gets an expanded frame when only a conversation is visible', () => {
        const frame = searchWindowFrame(stage, {
            expanded: true,
            conversationPresent: true,
        });

        expect(frame.height).toBe(SEARCH_WINDOW_RESULTS_HEIGHT);
    });
});

describe('user submits a prompt in the preview search window', () => {
    it('user gets a conversation reading when the panel is visible', () => {
        const document = parseDocument(`
            <div data-testid="search-view">
                <div data-testid="conversation-panel-host">
                    <div data-message-role="user"></div>
                    <div data-request-status></div>
                </div>
            </div>
        `);
        const state = searchContentState(document);

        expect(state).toMatchObject({
            expanded: true,
            conversationVisible: true,
            userMessageVisible: true,
            messageCount: 1,
            requestStatusVisible: true,
        });
    });

    it('user gets a compact reading when the retained quick search panel is hidden', () => {
        const document = parseDocument(`
            <div data-testid="search-view" data-height="60">
                <div data-testid="quick-search-panel" style="display: none"></div>
            </div>
        `);
        const state = searchContentState(document);

        expect(state).toMatchObject({
            expanded: false,
            conversationPresent: false,
            conversationVisible: false,
            userMessageVisible: false,
            messageCount: 0,
        });
        expect(
            searchWindowFrame(stage, {
                expanded: state.expanded,
                contentHeight: state.contentHeight,
            }).height
        ).toBe(SEARCH_WINDOW_IDLE_HEIGHT);
    });

    it('user gets an expanded reading when the quick search panel is visible', () => {
        const document = parseDocument(`
            <div data-testid="search-view">
                <div data-testid="quick-search-panel"></div>
            </div>
        `);
        const state = searchContentState(document);

        expect(state).toMatchObject({
            expanded: true,
            conversationPresent: false,
            conversationVisible: false,
        });
        expect(
            searchWindowFrame(stage, {
                expanded: state.expanded,
                contentHeight: state.contentHeight,
            }).height
        ).toBe(SEARCH_WINDOW_RESULTS_HEIGHT);
    });

    it('user gets the conversation state reported separately from its messages', () => {
        const document = parseDocument(`
            <div data-testid="search-view">
                <div data-testid="conversation-panel-host">
                    <div data-message-role="assistant"></div>
                </div>
            </div>
        `);
        const state = searchContentState(document);

        expect(state).toMatchObject({
            conversationPresent: true,
            conversationVisible: true,
            userMessageVisible: false,
            messageCount: 1,
            userMessageCount: 0,
        });
        expect(SEARCH_CONVERSATION_NOT_VISIBLE_MESSAGE).toBe(
            'the submitted prompt conversation is clipped inside the compact preview frame'
        );
        expect(SEARCH_CONVERSATION_REQUIRED_MESSAGE).toBe(
            'the submitted prompt did not reveal a conversation'
        );
    });

    it('user gets no success until the conversation renders a message', () => {
        const document = parseDocument(`
            <div data-testid="search-view">
                <div data-testid="conversation-panel-host"></div>
            </div>
        `);
        const state = searchContentState(document);

        expect(state).toMatchObject({
            expanded: true,
            conversationPresent: true,
            conversationVisible: false,
            messageCount: 0,
            userMessageCount: 0,
        });
    });

    it('user gets a passing check when the expanded frame shows the conversation', () => {
        expect(
            conversationCheck({
                conversationPresent: true,
                conversationVisible: true,
                messageCount: 2,
                userMessageCount: 1,
                requestStatusVisible: true,
                contentHeight: 420,
            })
        ).toEqual({
            status: 'pass',
            detail: '1 user message(s), request status visible',
        });
    });

    it('user gets a required-conversation failure when the prompt shows no conversation', () => {
        expect(
            conversationCheck({
                conversationPresent: false,
                conversationVisible: false,
                messageCount: 0,
                userMessageCount: 0,
                requestStatusVisible: false,
                contentHeight: 60,
            })
        ).toMatchObject({
            status: 'fail',
            message: 'the submitted prompt did not reveal a conversation',
            detail: '0 message(s), content height 60px',
        });
    });

    it('user gets a clipped-conversation failure when the fixed frame hides its messages', () => {
        expect(
            conversationCheck({
                conversationPresent: true,
                conversationVisible: false,
                messageCount: 1,
                userMessageCount: 1,
                requestStatusVisible: true,
                contentHeight: 60,
            })
        ).toMatchObject({
            status: 'fail',
            message:
                'the submitted prompt conversation is clipped inside the compact preview frame',
            detail: '1 message(s), content height 60px',
        });
    });
});

describe('user reviews the settings window without its shadow gutter', () => {
    it('user sees the designed 1120x700 surface inside the 1168x748 native window', () => {
        expect(WINDOW_SHADOW_GUTTER).toBe(24);
        expect(SETTINGS_WINDOW_CONTENT_WIDTH).toBe(1120);
        expect(SETTINGS_WINDOW_CONTENT_HEIGHT).toBe(700);
        expect(SETTINGS_WINDOW_WIDTH).toBe(1168);
        expect(SETTINGS_WINDOW_HEIGHT).toBe(748);
        expect(
            contentWindowFrame({
                width: SETTINGS_WINDOW_WIDTH,
                height: SETTINGS_WINDOW_HEIGHT,
                x: 0,
                y: 0,
            })
        ).toEqual({ width: 1120, height: 700, x: 24, y: 24 });
    });
});

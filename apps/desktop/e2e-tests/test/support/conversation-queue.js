/**
 * User-visible queue state and editor gestures shared by the queue/steer specs.
 */
import { callE2eBridge } from './desktop.js';

const DEFAULT_TIMEOUT_MS = 15000;
const PRIMARY_MODIFIER_KEY = process.platform === 'darwin' ? '\uE03D' : '\uE009';

export async function editorElement() {
    const editor = await $("[data-testid='search-editor-host'] .ProseMirror");
    await editor.waitForDisplayed();
    return editor;
}

function normalizeEditorText(text) {
    return String(text ?? '')
        .replace(/\s+/g, ' ')
        .trim();
}

export async function fillSearchDraft(text) {
    await callE2eBridge('setSearchQuery', text);
    const expected = normalizeEditorText(text);
    await browser.waitUntil(
        async () => normalizeEditorText(await (await editorElement()).getText()) === expected,
        {
            timeoutMsg: `The editor did not hold the complete draft: ${JSON.stringify(text)}`,
        }
    );
}

/**
 * Submit through the real keyboard path.
 *
 * The semantic intent is deliberately not encoded here: a spec passes the
 * physical chord so it can prove which setting the running app applied.
 */
export async function pressEditorKey(value, { modified = false, shift = false } = {}) {
    const editor = await editorElement();
    await editor.click();
    const modifiers = [modified ? PRIMARY_MODIFIER_KEY : null, shift ? '\uE008' : null].filter(
        Boolean
    );
    await browser.performActions([
        {
            type: 'key',
            id: 'queue-steer-keyboard',
            actions: [
                ...modifiers.map((modifier) => ({ type: 'keyDown', value: modifier })),
                { type: 'keyDown', value },
                { type: 'keyUp', value },
                ...modifiers.reverse().map((modifier) => ({ type: 'keyUp', value: modifier })),
            ],
        },
    ]);
    await browser.releaseActions();
}

export async function submitSearchDraft(chord) {
    await pressEditorKey('\uE006', { modified: chord === 'modified' });
    await browser.waitUntil(async () => (await (await editorElement()).getText()).trim() === '', {
        timeoutMsg: `Submitting with ${chord} Enter left the prompt in the editor.`,
    });
}

export async function readConversationMessages() {
    return browser.execute(() => {
        const colorCanvas = document.createElement('canvas');
        colorCanvas.width = 1;
        colorCanvas.height = 1;
        const colorContext = colorCanvas.getContext('2d', { willReadFrequently: true });
        const comparableColor = (color) => {
            if (!color || !colorContext) return null;
            colorContext.clearRect(0, 0, 1, 1);
            colorContext.fillStyle = color;
            colorContext.fillRect(0, 0, 1, 1);
            const [red, green, blue] = colorContext.getImageData(0, 0, 1, 1).data;
            return `rgb(${red}, ${green}, ${blue})`;
        };

        return [...document.querySelectorAll('[data-message-id]')].map((node, index) => {
            const pendingBubble = node.querySelector('[data-pending-delivery]');
            const bubble = node.querySelector('[data-testid="user-message-bubble"]');
            const textElement = node.querySelector('.user-text');
            const expandToggle = node.querySelector('[data-testid="user-message-expand-toggle"]');
            const pendingActions = node.querySelector('[data-testid="pending-message-actions"]');
            const style = bubble ? getComputedStyle(bubble) : null;
            const textStyle = textElement ? getComputedStyle(textElement) : null;
            const pendingActionsStyle = pendingActions ? getComputedStyle(pendingActions) : null;

            return {
                index,
                id: node.getAttribute('data-message-id'),
                role: node.getAttribute('data-message-role'),
                text: textElement?.textContent?.trim() ?? null,
                textColor: textStyle?.color ?? null,
                textColorRgb: comparableColor(textStyle?.color),
                pendingDelivery: pendingBubble?.getAttribute('data-pending-delivery') ?? null,
                borderStyle: style?.borderTopStyle ?? null,
                borderColor: style?.borderTopColor ?? null,
                borderColorRgb: comparableColor(style?.borderTopColor),
                backgroundColor: style?.backgroundColor ?? null,
                editing: pendingBubble?.getAttribute('data-editing') === 'true',
                hasPendingActions: Boolean(pendingActions),
                pendingActionText: pendingActions?.textContent?.trim() ?? null,
                pendingActionColor: pendingActionsStyle?.color ?? null,
                pendingActionColorRgb: comparableColor(pendingActionsStyle?.color),
                pendingActionIconCount: pendingActions
                    ? pendingActions.querySelectorAll('svg.app-icon').length
                    : 0,
                editingStatus:
                    node
                        .querySelector('[data-testid="pending-message-edit-status"]')
                        ?.textContent?.trim() ?? null,
                hasCancelEdit: Boolean(
                    node.querySelector('[data-testid="pending-message-cancel-edit"]')
                ),
                hasSendNow: Boolean(node.querySelector('[data-testid="pending-message-send-now"]')),
                sendNowLabel:
                    node
                        .querySelector('[data-testid="pending-message-send-now"]')
                        ?.getAttribute('aria-label') ?? null,
                hasEdit: Boolean(node.querySelector('[data-testid="pending-message-edit"]')),
                hasRemove: Boolean(node.querySelector('[data-testid="pending-message-remove"]')),
                hasExpandToggle: Boolean(expandToggle),
                expanded: expandToggle?.getAttribute('aria-expanded') ?? null,
                collapsed: textElement?.getAttribute('data-collapsed') === 'true',
                lineClamp: textStyle?.webkitLineClamp ?? null,
                textClientHeight: textElement?.clientHeight ?? null,
                textScrollHeight: textElement?.scrollHeight ?? null,
                actionLabels: [...node.querySelectorAll('button[aria-label]')].map((button) =>
                    button.getAttribute('aria-label')
                ),
                loading: Boolean(node.querySelector('[data-request-status]')),
            };
        });
    });
}

export async function waitForConversation(predicate, message, timeoutMs = DEFAULT_TIMEOUT_MS) {
    let lastState = [];
    try {
        await browser.waitUntil(
            async () => {
                lastState = await readConversationMessages();
                return predicate(lastState);
            },
            { timeout: timeoutMs, timeoutMsg: message }
        );
    } catch (error) {
        throw new Error(`${message}\nLast conversation state: ${JSON.stringify(lastState)}`, {
            cause: error,
        });
    }
    return lastState;
}

export function pendingMessages(state) {
    return state.filter((message) => message.pendingDelivery !== null);
}

export function messageByText(state, text) {
    const expected = normalizeEditorText(text);
    return state.find((message) => normalizeEditorText(message.text) === expected) ?? null;
}

export function loadingMessage(state) {
    return state.find((message) => message.loading) ?? null;
}

export async function clickMessageAction(message, testId) {
    const action = await $(`[data-message-id="${message.id}"] [data-testid="${testId}"]`);
    await browser.execute((element) => {
        element.scrollIntoView({ block: 'center', inline: 'nearest' });
    }, action);
    await action.waitForClickable();
    const hitTarget = await browser.execute((element) => {
        const rect = element.getBoundingClientRect();
        const centerX = rect.left + rect.width / 2;
        const centerY = rect.top + rect.height / 2;
        const target = document.elementFromPoint(centerX, centerY);
        return {
            hitsAction: Boolean(target && (target === element || element.contains(target))),
            target: target?.outerHTML?.slice(0, 240) ?? null,
            rect: { top: rect.top, right: rect.right, bottom: rect.bottom, left: rect.left },
        };
    }, action);
    if (!hitTarget.hitsAction) {
        throw new Error(
            `The ${testId} action was covered at its click point: ${JSON.stringify(hitTarget)}.`
        );
    }
    await action.click();
}

export async function hoverPendingAction(message, testId) {
    const action = await $(`[data-message-id="${message.id}"] [data-testid="${testId}"]`);
    await action.waitForDisplayed();
    await action.moveTo();
    await browser.waitUntil(
        () =>
            browser.execute(
                (target) =>
                    target.matches(':hover') &&
                    target
                        .getAnimations({ subtree: true })
                        .every(
                            (animation) => !animation.pending && animation.playState !== 'running'
                        ),
                action
            ),
        { timeoutMsg: `The ${testId} action did not reach its settled hover state.` }
    );
    return action;
}

export async function backgroundColorOf(element) {
    return browser.execute((target) => getComputedStyle(target).backgroundColor, element);
}

export async function dragQueuedMessage(source, target, beforeDrop) {
    const sourceBubble = await $(
        `[data-message-id="${source.id}"] [data-pending-delivery="queue"]`
    );
    const targetBubble = await $(
        `[data-message-id="${target.id}"] [data-pending-delivery="queue"]`
    );
    await sourceBubble.scrollIntoView();
    let settledRects;
    await browser.waitUntil(
        async () => {
            const rects = await browser.execute(
                (...elements) =>
                    elements.map((element) => {
                        const { left, top, width, height } = element.getBoundingClientRect();
                        return { left, top, width, height };
                    }),
                sourceBubble,
                targetBubble
            );
            const stable = rects.every((rect, index) =>
                ['left', 'top', 'width', 'height'].every(
                    (coordinate) => rect[coordinate] === settledRects?.[index]?.[coordinate]
                )
            );
            settledRects = rects;
            return stable;
        },
        { timeoutMsg: 'The queued-message drag targets did not reach stable positions.' }
    );

    const [sourceRect, targetRect] = settledRects;
    const sourceX = Math.round(sourceRect.left + sourceRect.width / 2);
    const sourceY = Math.round(sourceRect.top + sourceRect.height / 2);
    const targetX = Math.round(targetRect.left + targetRect.width / 2);
    const targetY = Math.round(targetRect.top + targetRect.height / 2);

    await browser.performActions([
        {
            type: 'pointer',
            id: 'pending-queue-drag',
            parameters: { pointerType: 'mouse' },
            actions: [
                { type: 'pointerMove', duration: 0, origin: 'viewport', x: sourceX, y: sourceY },
                { type: 'pointerDown', button: 0 },
                { type: 'pause', duration: 150 },
                {
                    type: 'pointerMove',
                    duration: 120,
                    origin: 'viewport',
                    x: sourceX,
                    y: sourceY - 12,
                },
                {
                    type: 'pointerMove',
                    duration: 280,
                    origin: 'viewport',
                    x: targetX,
                    y: targetY,
                },
                { type: 'pause', duration: 120 },
            ],
        },
    ]);

    try {
        await beforeDrop?.();
    } finally {
        await browser.performActions([
            {
                type: 'pointer',
                id: 'pending-queue-drag',
                actions: [{ type: 'pointerUp', button: 0 }],
            },
        ]);
        await browser.releaseActions();
    }
}

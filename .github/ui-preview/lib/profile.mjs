/**
 * Capture geometry for the preview stage.
 *
 * The app is driven in logical (CSS) pixels, while the video and screenshots
 * are captured in physical pixels. Keeping the two separate lets a HiDPI
 * runner render the same 1280x800 layout at 2x without moving or resizing the
 * windows in the recording.
 *
 * The same module owns the window frames placed inside that stage: the empty
 * search window is a compact bar, and results use the taller frame the app
 * normally grows into.
 */

export const DEFAULT_STAGE_WIDTH = 1280;
export const DEFAULT_STAGE_HEIGHT = 900;
export const DEFAULT_STAGE_TOP = 64;
export const DEFAULT_SCALE_FACTOR = 1;

function positiveInteger(value, fallback) {
    const number = Number(value);
    return Number.isFinite(number) && number > 0 ? Math.round(number) : fallback;
}

function positiveScale(value, fallback) {
    const number = Number(value);
    return Number.isFinite(number) && number > 0 && number <= 4
        ? Math.round(number * 100) / 100
        : fallback;
}

function even(value) {
    const rounded = Math.max(2, Math.round(value));
    return rounded % 2 === 0 ? rounded : rounded + 1;
}

/**
 * @param {NodeJS.ProcessEnv | Record<string, string | undefined>} [env]
 * @returns {{
 *   stage: { width: number, height: number, top: number },
 *   scale: number,
 *   physical: { width: number, height: number, top: number }
 * }}
 */
export function resolveCaptureProfile(env = process.env) {
    const stage = {
        width: positiveInteger(env.UI_PREVIEW_STAGE_WIDTH, DEFAULT_STAGE_WIDTH),
        height: positiveInteger(env.UI_PREVIEW_STAGE_HEIGHT, DEFAULT_STAGE_HEIGHT),
        top: positiveInteger(env.UI_PREVIEW_STAGE_TOP, DEFAULT_STAGE_TOP),
    };
    const scale = positiveScale(env.UI_PREVIEW_SCALE_FACTOR, DEFAULT_SCALE_FACTOR);

    return {
        stage,
        scale,
        physical: {
            width: even(stage.width * scale),
            height: even(stage.height * scale),
            top: even(stage.top * scale),
        },
    };
}

export function stageLabel(profile) {
    return `${profile.physical.width}x${profile.physical.height} (${profile.scale}x)`;
}

export const SEARCH_WINDOW_WIDTH = 750;
export const SEARCH_WINDOW_IDLE_HEIGHT = 60;
export const SEARCH_WINDOW_RESULTS_HEIGHT = 420;
export const SEARCH_CONVERSATION_REQUIRED_MESSAGE =
    'the submitted prompt did not reveal a conversation';
export const SEARCH_CONVERSATION_NOT_VISIBLE_MESSAGE =
    'the submitted prompt conversation is clipped inside the compact preview frame';

/**
 * Floating top-level windows reserve transparent room for their CSS shadow.
 * The search host has its own 48px visual outset and must not use this gutter.
 */
export const WINDOW_SHADOW_GUTTER = 24;
export const SETTINGS_WINDOW_CONTENT_WIDTH = 1120;
export const SETTINGS_WINDOW_CONTENT_HEIGHT = 700;
export const SETTINGS_WINDOW_WIDTH = SETTINGS_WINDOW_CONTENT_WIDTH + WINDOW_SHADOW_GUTTER * 2;
export const SETTINGS_WINDOW_HEIGHT = SETTINGS_WINDOW_CONTENT_HEIGHT + WINDOW_SHADOW_GUTTER * 2;

/**
 * The inverse of the native frame expansion, used to crop a native capture
 * back to the content a reviewer should see.
 */
export function contentWindowFrame(frame, gutter = WINDOW_SHADOW_GUTTER) {
    return {
        width: Math.max(1, frame.width - gutter * 2),
        height: Math.max(1, frame.height - gutter * 2),
        x: frame.x + gutter,
        y: frame.y + gutter,
    };
}

/**
 * @param {{ width: number, height: number }} stage
 * @param {{ expanded?: boolean, contentHeight?: number, conversationPresent?: boolean }} [options]
 */
export function searchWindowFrame(stage, options = {}) {
    const width = Math.min(SEARCH_WINDOW_WIDTH, Math.max(420, stage.width - 80));
    const measured = Number(options.contentHeight);
    const measuredHeight =
        !options.conversationPresent &&
        Number.isFinite(measured) &&
        measured > SEARCH_WINDOW_IDLE_HEIGHT
            ? Math.min(SEARCH_WINDOW_RESULTS_HEIGHT, Math.round(measured))
            : SEARCH_WINDOW_RESULTS_HEIGHT;
    const preferredHeight = options.expanded ? measuredHeight : SEARCH_WINDOW_IDLE_HEIGHT;
    const height = Math.min(
        preferredHeight,
        Math.max(SEARCH_WINDOW_IDLE_HEIGHT, stage.height - 80)
    );

    return {
        width,
        height,
        x: Math.max(0, Math.round((stage.width - width) / 2)),
        y: Math.max(0, Math.round((stage.height - height) / 2)),
    };
}

/**
 * Reads the search surface from the renderer. The conversation host is the
 * stable contract: it exists while a conversation renders, even when preview
 * mode has clipped it to the compact bar. The user message and request status
 * are reported separately so a recording states what it actually saw.
 */
export function searchContentState(document) {
    const root = document.querySelector("[data-testid='search-view']");
    const panel = document.querySelector("[data-testid='quick-search-panel']");
    const conversation = document.querySelector("[data-testid='conversation-panel-host']");
    const messageNodes = Array.from(conversation?.querySelectorAll?.('[data-message-role]') ?? []);
    const userMessages = Array.from(
        conversation?.querySelectorAll?.("[data-message-role='user']") ?? []
    );
    const requestStatus = Array.from(
        conversation?.querySelectorAll?.('[data-request-status]') ?? []
    );
    const rootRect = root?.getBoundingClientRect?.() ?? { width: 0, height: 0 };
    const contentHeight = Math.max(root?.scrollHeight ?? 0, rootRect.height ?? 0);
    const conversationPresent = Boolean(conversation);
    const conversationRect = conversation?.getBoundingClientRect?.();
    const viewportWidth =
        document.defaultView?.innerWidth ?? document.documentElement?.clientWidth ?? 0;
    const viewportHeight =
        document.defaultView?.innerHeight ?? document.documentElement?.clientHeight ?? 0;
    const isVisible = (element) => {
        const rect = element?.getBoundingClientRect?.();

        if (!rect || rect.width <= 0 || rect.height <= 0) {
            return false;
        }

        const style = document.defaultView?.getComputedStyle?.(element) ?? {};

        if (
            style.display === 'none' ||
            style.visibility === 'hidden' ||
            Number(style.opacity) === 0
        ) {
            return false;
        }

        const insideViewport =
            rect.right > 0 &&
            rect.bottom > 0 &&
            rect.left < viewportWidth &&
            rect.top < viewportHeight;
        const insideConversation =
            !conversationRect ||
            (rect.right > conversationRect.left &&
                rect.bottom > conversationRect.top &&
                rect.left < conversationRect.right &&
                rect.top < conversationRect.bottom);

        return insideViewport && insideConversation;
    };
    const conversationVisible = conversationPresent && messageNodes.some(isVisible);
    const userMessageVisible = userMessages.some(isVisible);
    const requestStatusVisible = requestStatus.some(isVisible);
    const expanded = conversationPresent || Boolean(panel) || contentHeight > 120;

    return {
        expanded,
        contentHeight,
        conversationPresent,
        conversationVisible,
        userMessageVisible,
        messageCount: messageNodes.length,
        userMessageCount: userMessages.length,
        requestStatusVisible,
    };
}

/**
 * Builds the renderer-side script from the function above so the tested helper
 * and the WebDriver command cannot drift apart.
 */
export function searchContentScript() {
    return `
return (${searchContentState.toString()})(document);
`;
}

export const SEARCH_CONTENT_SCRIPT = searchContentScript();

/**
 * Decides whether a submitted prompt produced evidence a reviewer can see.
 * The fixed conversation frame must already be applied when this runs.
 */
export function conversationCheck(content) {
    if (content?.conversationVisible) {
        return {
            status: 'pass',
            detail: `${content.userMessageCount ?? 0} user message(s), request status ${
                content.requestStatusVisible ? 'visible' : 'not visible'
            }`,
        };
    }

    return {
        status: 'fail',
        message: content?.conversationPresent
            ? SEARCH_CONVERSATION_NOT_VISIBLE_MESSAGE
            : SEARCH_CONVERSATION_REQUIRED_MESSAGE,
        detail: `${content?.messageCount ?? 0} message(s), content height ${content?.contentHeight ?? 0}px`,
    };
}

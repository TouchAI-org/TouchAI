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
/**
 * Transparent room the app leaves inside each native window for its CSS
 * shadow. The recorder works in visible-content coordinates and only converts
 * to native ones where the platform requires it.
 */
export const WINDOW_SHADOW_GUTTER = 24;

/**
 * @param {{ width: number, height: number }} stage
 * @param {{ expanded?: boolean, contentHeight?: number }} [options]
 */
export function searchWindowFrame(stage, options = {}) {
    const width = Math.min(SEARCH_WINDOW_WIDTH, Math.max(420, stage.width - 80));
    const measured = Number(options.contentHeight);
    const preferredHeight = options.expanded
        ? Number.isFinite(measured) && measured > SEARCH_WINDOW_IDLE_HEIGHT
            ? Math.min(SEARCH_WINDOW_RESULTS_HEIGHT, Math.round(measured))
            : SEARCH_WINDOW_RESULTS_HEIGHT
        : SEARCH_WINDOW_IDLE_HEIGHT;
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
 * Converts a visible-content frame into the native window that contains it.
 *
 * The app draws a 24px transparent gutter on every side so the browser can
 * anti-alias the radius and paint a CSS shadow. X11 window managers (and
 * xdotool) size the native window, so Linux previews have to add that gutter
 * back; WebDriver on Windows and macOS reports content dimensions, so it uses
 * the frame as-is.
 */
export function nativeWindowFrame(frame, gutter = WINDOW_SHADOW_GUTTER) {
    return {
        width: frame.width + gutter * 2,
        height: frame.height + gutter * 2,
        x: frame.x - gutter,
        y: frame.y - gutter,
    };
}

/**
 * The inverse of `nativeWindowFrame`, used to crop a native capture back to
 * the content a reviewer should see.
 */
export function contentWindowFrame(frame, gutter = WINDOW_SHADOW_GUTTER) {
    return {
        width: Math.max(1, frame.width - gutter * 2),
        height: Math.max(1, frame.height - gutter * 2),
        x: frame.x + gutter,
        y: frame.y + gutter,
    };
}

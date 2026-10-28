/**
 * Capture geometry for the preview stage.
 *
 * The app is driven in logical (CSS) pixels, while the video and screenshots
 * are captured in physical pixels. Keeping the two separate lets a HiDPI
 * runner render the same 1280x800 layout at 2x without moving or resizing the
 * windows in the recording.
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

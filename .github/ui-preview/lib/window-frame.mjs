/**
 * Chooses the centered search-window frames used by the preview recorder.
 *
 * The empty search window is a compact bar. Results and conversations use the
 * expanded frame that the app normally grows into.
 */

export const SEARCH_WINDOW_WIDTH = 750;
export const SEARCH_WINDOW_IDLE_HEIGHT = 60;
export const SEARCH_WINDOW_RESULTS_HEIGHT = 420;

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

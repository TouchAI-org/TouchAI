export type SearchOverlaySide = 'top' | 'bottom';
export type SearchOverlayAlign = 'start' | 'center' | 'end';

export interface SearchOverlayRect {
    left: number;
    top: number;
    right: number;
    bottom: number;
    width: number;
    height: number;
}

export interface SearchOverlaySize {
    width: number;
    height: number;
}

export interface SearchOverlayViewport {
    width: number;
    height: number;
}

export interface SearchOverlayPositionOptions {
    anchor: SearchOverlayRect;
    overlay: SearchOverlaySize;
    viewport: SearchOverlayViewport;
    preferredSide?: SearchOverlaySide;
    align?: SearchOverlayAlign;
    gap?: number;
    viewportPadding?: number;
    /**
     * Whether the overlay may move to the opposite side of its anchor.
     *
     * Only enable this when the viewport is fixed. A bounded host grows to
     * `requiredViewportHeight`, so flipping to the top there would put the overlay inside the
     * surface instead of below it.
     */
    allowFlip?: boolean;
    /** Hard native work-area limit, independent of the host's current compact size. */
    maxViewportHeight?: number;
    minViewportTop?: number;
}

export interface SearchOverlayPosition {
    left: number;
    top: number;
    side: SearchOverlaySide;
    requiredViewportHeight: number | null;
    maxHeight?: number;
}

function clamp(value: number, minimum: number, maximum: number): number {
    if (maximum < minimum) {
        return minimum;
    }

    return Math.min(Math.max(value, minimum), maximum);
}

function resolveAlignedLeft(
    anchor: SearchOverlayRect,
    overlayWidth: number,
    align: SearchOverlayAlign
): number {
    if (align === 'end') {
        return anchor.right - overlayWidth;
    }

    if (align === 'center') {
        return anchor.left + (anchor.width - overlayWidth) / 2;
    }

    return anchor.left;
}

export function calculateSearchOverlayPosition(
    options: SearchOverlayPositionOptions
): SearchOverlayPosition {
    const preferredSide = options.preferredSide ?? 'bottom';
    const align = options.align ?? 'start';
    const gap = options.gap ?? 8;
    const viewportPadding = options.viewportPadding ?? 8;
    const minimumTop = (options.minViewportTop ?? 0) + viewportPadding;
    const spaceAbove = options.anchor.top - minimumTop - gap;
    const viewportHeight = options.maxViewportHeight ?? options.viewport.height;
    const spaceBelow = viewportHeight - viewportPadding - options.anchor.bottom - gap;
    const preferredSpace = preferredSide === 'bottom' ? spaceBelow : spaceAbove;
    const oppositeSpace = preferredSide === 'bottom' ? spaceAbove : spaceBelow;
    const hardLimit = options.maxViewportHeight !== undefined;
    const allowFlip = hardLimit || (options.allowFlip ?? true);
    const side =
        allowFlip &&
        preferredSpace < options.overlay.height &&
        (oppositeSpace >= options.overlay.height || (hardLimit && oppositeSpace > preferredSpace))
            ? preferredSide === 'bottom'
                ? 'top'
                : 'bottom'
            : preferredSide;
    const maxHeight = hardLimit ? Math.max(0, side === 'top' ? spaceAbove : spaceBelow) : undefined;
    const overlayHeight = Math.min(options.overlay.height, maxHeight ?? Infinity);
    const naturalTop =
        side === 'bottom' ? options.anchor.bottom + gap : options.anchor.top - gap - overlayHeight;
    const maximumLeft = options.viewport.width - viewportPadding - options.overlay.width;
    const maximumTop = viewportHeight - viewportPadding - overlayHeight;
    const requiredViewportHeight =
        side === 'bottom' ? naturalTop + overlayHeight + viewportPadding : null;

    return {
        left: clamp(
            resolveAlignedLeft(options.anchor, options.overlay.width, align),
            viewportPadding,
            maximumLeft
        ),
        // A bounded host is resized to `requiredViewportHeight` after this
        // measurement. Keep the overlay at its natural anchor position while
        // that resize is in flight; clamping it to the temporary compact
        // viewport makes the overlay visibly jump down from the top edge.
        top:
            !hardLimit && side === 'bottom' && requiredViewportHeight !== null
                ? Math.max(naturalTop, minimumTop)
                : clamp(naturalTop, minimumTop, maximumTop),
        side,
        requiredViewportHeight,
        ...(maxHeight === undefined ? {} : { maxHeight }),
    };
}

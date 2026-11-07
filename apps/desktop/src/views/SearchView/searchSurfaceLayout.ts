// Copyright (c) 2026. Qian Cheng. Licensed under GPL v3.

/**
 * Pure geometry for the search surface.
 *
 * The surface has exactly one height source: the measured content height. This
 * module turns that measurement into the native host geometry and the visible
 * card box, so no component has to reason about intermediate animation state.
 */

import { SEARCH_WINDOW_VISUAL_OUTSET } from './searchWindowRegions';

export const SEARCH_PANEL_MIN_HEIGHT = 60;
export const SEARCH_PANEL_HEIGHT_TOLERANCE = 0.5;

/** The work area intersected with the host, in client CSS coordinates. */
export function resolveVisibleSearchViewport(input: {
    viewportWidth: number;
    viewportHeight: number;
    hostX: number;
    hostY: number;
    workAreaLeft: number;
    workAreaTop: number;
    workAreaWidth: number;
    workAreaHeight: number;
    scaleFactor: number;
}) {
    const top = Math.min(
        input.viewportHeight,
        Math.max(0, (input.workAreaTop - input.hostY) / input.scaleFactor)
    );
    const bottom = Math.max(
        top,
        Math.min(
            input.viewportHeight,
            (input.workAreaTop + input.workAreaHeight - input.hostY) / input.scaleFactor
        )
    );
    const left = Math.min(
        input.viewportWidth,
        Math.max(0, (input.workAreaLeft - input.hostX) / input.scaleFactor)
    );
    const right = Math.max(
        left,
        Math.min(
            input.viewportWidth,
            (input.workAreaLeft + input.workAreaWidth - input.hostX) / input.scaleFactor
        )
    );
    return { left, right, top, bottom };
}

export interface ContentPanelHeightInput {
    /** Measured intrinsic height of the page content. */
    contentHeight: number;
    /** Compact editor height, used as the floor. */
    compactHeight: number;
    /** Conversation cap; the content is clamped to it. */
    maxHeight: number;
}

/**
 * Clamp a measured content height into the panel height the host should adopt.
 *
 * Returns whole pixels so the renderer and the native frame round identically.
 */
export function resolveContentPanelHeight(input: ContentPanelHeightInput): number {
    const compact = Math.max(
        SEARCH_PANEL_MIN_HEIGHT,
        Math.round(
            Number.isFinite(input.compactHeight) ? input.compactHeight : SEARCH_PANEL_MIN_HEIGHT
        )
    );
    const max = Math.max(
        compact,
        Math.round(Number.isFinite(input.maxHeight) ? input.maxHeight : compact)
    );
    const measured = Number.isFinite(input.contentHeight)
        ? Math.ceil(input.contentHeight)
        : compact;

    return Math.min(max, Math.max(compact, measured));
}

export interface SurfacePanelStyleInput {
    scaleFactor: number;
    maximized: boolean;
    panelHeight?: number;
    viewportHeight?: number;
    centerY?: number | null;
    minTop?: number;
    maxBottom?: number;
}

/**
 * Resolve the panel box inside the bounded native host.
 *
 * The host reserves vertical space once. Panel size and position share the same
 * renderer, so native movement notifications cannot split an animation frame.
 */
export function resolveSurfacePanelStyle(input: SurfacePanelStyleInput) {
    const scaleFactor =
        Number.isFinite(input.scaleFactor) && input.scaleFactor > 0 ? input.scaleFactor : 1;
    const borderWidth = `${Math.max(1, Math.round(scaleFactor)) / scaleFactor}px`;

    if (input.maximized) {
        return {
            width: '100%',
            height: '100%',
            left: '0px',
            top: '0px',
            right: 'auto',
            bottom: 'auto',
            transform: 'none',
            '--search-surface-border-width': borderWidth,
        };
    }

    const height = input.panelHeight ?? 0;
    const top = Math.max(
        input.minTop ?? 0,
        Math.min(
            (input.centerY ?? (input.viewportHeight ?? 0) / 2) - height / 2,
            (input.maxBottom ?? input.viewportHeight ?? height) - height
        )
    );
    return {
        left: `${SEARCH_WINDOW_VISUAL_OUTSET}px`,
        right: `${SEARCH_WINDOW_VISUAL_OUTSET}px`,
        top: `${top}px`,
        bottom: 'auto',
        width: 'auto',
        height: `${height}px`,
        maxHeight: 'none',
        minHeight: '0px',
        transform: 'none',
        '--search-surface-border-width': borderWidth,
    };
}

export interface PanelHeightCommitInput {
    current: number | null;
    next: number;
    tolerance?: number;
}

/** Decide whether a measured height is worth a native resize round-trip. */
export function shouldCommitPanelHeight(input: PanelHeightCommitInput): boolean {
    const tolerance = input.tolerance ?? SEARCH_PANEL_HEIGHT_TOLERANCE;
    if (input.current === null || !Number.isFinite(input.current)) {
        return Number.isFinite(input.next);
    }

    return Math.abs(input.next - input.current) > tolerance;
}

// Copyright (c) 2026. Qian Cheng. Licensed under GPL v3.

/**
 * Pure geometry for the search surface.
 *
 * The surface has exactly one height source: the measured content height. This
 * module turns that measurement into the native host geometry and the visible
 * card box, so no component has to reason about intermediate animation state.
 */

import { SEARCH_WINDOW_VISUAL_OUTSET } from './searchWindowRegions';
import { SEARCH_WINDOW_TOP_INSET } from './windowSizing';

export const SEARCH_PANEL_MIN_HEIGHT = 60;
export const SEARCH_PANEL_HEIGHT_TOLERANCE = 0.5;

/** Whole logical pixels that fit after reserving the native shadow envelope. */
export function resolveSurfaceWorkAreaHeight(physicalHeight: number, scaleFactor: number): number {
    return Math.max(
        1,
        Math.floor(
            (physicalHeight -
                SEARCH_WINDOW_TOP_INSET -
                Math.ceil(SEARCH_WINDOW_VISUAL_OUTSET * scaleFactor)) /
                scaleFactor
        )
    );
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
}

/**
 * Resolve the panel box inside the bounded native host.
 *
 * The panel always fills the host interior: the host owns the animated height and
 * the card must be exactly what the user sees, so the box is expressed as fixed
 * insets instead of a JS height. `--search-surface-border-width` keeps a one
 * physical pixel border at any display scale.
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

    return {
        left: `${SEARCH_WINDOW_VISUAL_OUTSET}px`,
        right: `${SEARCH_WINDOW_VISUAL_OUTSET}px`,
        top: `${SEARCH_WINDOW_TOP_INSET / scaleFactor}px`,
        bottom: `${SEARCH_WINDOW_VISUAL_OUTSET}px`,
        width: 'auto',
        height: 'auto',
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

export interface SurfaceHostContentHeightInput {
    panelHeight: number;
    overlayBottom: number | null;
    overlayRequiredViewportHeight: number | null;
    scaleFactor: number;
}

/**
 * Logical client-space extent the native host must reserve.
 *
 * The panel starts below the top inset, and fixed overlays may extend past its
 * bottom edge; the host reserves whichever is larger.
 */
export function resolveSurfaceHostContentHeight(input: SurfaceHostContentHeightInput): number {
    const scaleFactor =
        Number.isFinite(input.scaleFactor) && input.scaleFactor > 0 ? input.scaleFactor : 1;
    const panelHeight = Number.isFinite(input.panelHeight) ? input.panelHeight : 0;
    const panelBottom = SEARCH_WINDOW_TOP_INSET / scaleFactor + panelHeight;
    const overlays = [input.overlayBottom, input.overlayRequiredViewportHeight].filter(
        (value): value is number => value !== null && Number.isFinite(value)
    );

    return Math.max(panelBottom, ...overlays);
}

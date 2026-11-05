// Copyright (c) 2026. 千诚. Licensed under GPL v3.

/**
 * Where the search surface sits on screen.
 *
 * The surface is one native window whose height follows the panel inside it, and every rule about
 * moving that window is expressed here as a state machine instead of as conditions spread over the
 * commit path. Two questions are answered:
 *
 * 1. `resolveSurfaceGeometryMode` -- which mode is the surface in, given what is open?
 * 2. `resolveSurfaceFrameY` -- where does the frame go in that mode, given the height it is about
 *    to have?
 *
 * The answer to (2) is absolute, so asking twice for the same height can never move the frame
 * twice. It is also a pure function of the mode, so closing a popup puts the frame back without
 * anything having to remember that a popup was open before.
 */

/**
 * How far the frame moves when the panel grows from `compactHeight` to `panelHeight`.
 *
 * The card is pinned to the frame's top edge, so its centre sits at
 * `frameY + topInset + panel/2`. Keeping that centre fixed while the panel grows by G means
 * moving the frame by `-G/2`, in physical pixels because the frame is placed in them.
 */
export function resolveFrameShiftForGrowth(
    panelHeight: number,
    compactHeight: number,
    scaleFactor: number
): number {
    return -Math.round(((panelHeight - compactHeight) / 2) * scaleFactor);
}

export type SurfaceGeometryMode =
    /** Nothing open: the bar sits on the origin it idles at. */
    | 'idle'
    /** The surface itself is growing (results list, conversation): it centres in its own motion. */
    | 'surface'
    /** A popup is open over the surface: the window must not move at all. */
    | 'popup'
    /** The user dragged the panel: their size wins and the frame stays where it is. */
    | 'manual'
    /** Work-area placement owns the frame. */
    | 'maximized';

export interface SurfaceGeometryInput {
    /** Height this commit applies to the panel. */
    panelHeight: number;
    /** Height of the closed surface. */
    compactHeight: number;
    /** The model picker or the session history is open over the surface. */
    popupOpen: boolean;
    maximized: boolean;
    manualOverride: boolean;
}

/**
 * Which mode the surface is in.
 *
 * `popup` wins over the height: a popup grows the host envelope while the panel stays at the
 * compact height, and that must not be mistaken for the surface being at rest.
 */
export function resolveSurfaceGeometryMode(input: SurfaceGeometryInput): SurfaceGeometryMode {
    if (input.maximized) return 'maximized';
    if (input.manualOverride) return 'manual';
    if (input.popupOpen) return 'popup';
    if (input.panelHeight <= input.compactHeight + 1) return 'idle';
    return 'surface';
}

/** Only a surface that grows on its own centres itself; every other mode holds still. */
export function surfaceModeCentres(mode: SurfaceGeometryMode): boolean {
    return mode === 'surface';
}

export interface SurfaceFrameInput {
    mode: SurfaceGeometryMode;
    /** Height the panel will have in this commit. */
    panelHeight: number;
    compactHeight: number;
    scaleFactor: number;
    /** Frame position while the surface idles, in physical pixels. */
    idleOriginY: number | null;
    /** Frame position at the moment a popup took the layout over, in physical pixels. */
    frozenOriginY: number | null;
}

/**
 * Absolute physical y for the frame, or null when something else owns it.
 *
 * `idle` sits on the idle origin, `popup` and `manual` hold the origin they were given, and
 * `surface` moves up by half of the growth so the surface opens out of its own middle. `maximized`
 * is placed by the work-area commit.
 */
export function resolveSurfaceFrameY(input: SurfaceFrameInput): number | null {
    if (input.mode === 'maximized') return null;
    if (input.mode === 'manual') return null;
    if (input.mode === 'popup') return input.frozenOriginY;
    if (input.idleOriginY === null) return null;
    if (input.mode === 'idle') return input.idleOriginY;
    return (
        input.idleOriginY +
        resolveFrameShiftForGrowth(input.panelHeight, input.compactHeight, input.scaleFactor)
    );
}

import { SEARCH_WINDOW_VISUAL_OUTSET } from './searchWindowRegions';
import { SEARCH_WINDOW_TOP_INSET } from './windowSizing';

export type SearchPanelResizeDirection = 'n' | 'ne' | 'e' | 'se' | 's' | 'sw' | 'w' | 'nw';

export interface SearchPanelGeometry {
    width: number;
    height: number;
    physicalOrigin: { x: number; y: number };
}

export interface SearchPanelWorkArea {
    position: { x: number; y: number };
    size: { width: number; height: number };
}

export interface SearchPanelFrame {
    left: number;
    top: number;
    width: number;
    height: number;
}

export interface ResizeSearchPanelFrameInput {
    startFrame: SearchPanelFrame;
    direction: SearchPanelResizeDirection;
    deltaX: number;
    deltaY: number;
    viewportWidth: number;
    viewportHeight: number;
    scaleFactor: number;
    minWidth: number;
    minHeight: number;
    visualInset: number;
    allowHeightOverride: boolean;
}

export function resizeSearchPanelFrame(input: ResizeSearchPanelFrameInput): SearchPanelFrame {
    const scaleFactor =
        Number.isFinite(input.scaleFactor) && input.scaleFactor > 0 ? input.scaleFactor : 1;
    const snap = (value: number) => Math.round(value * scaleFactor) / scaleFactor;
    const snapInsideStart = (value: number) => Math.ceil(value * scaleFactor) / scaleFactor;
    const snapInsideEnd = (value: number) => Math.floor(value * scaleFactor) / scaleFactor;
    const clamp = (value: number, min: number, max: number) => Math.min(Math.max(value, min), max);

    const startLeft = snap(input.startFrame.left);
    const startTop = snap(input.startFrame.top);
    const startRight = snap(input.startFrame.left + input.startFrame.width);
    const startBottom = snap(input.startFrame.top + input.startFrame.height);
    const inset = Math.max(0, Number.isFinite(input.visualInset) ? input.visualInset : 0);
    const minLeft = snapInsideStart(inset);
    const minTop = snapInsideStart(inset);
    const maxRight = snapInsideEnd(Math.max(minLeft, input.viewportWidth - inset));
    const maxBottom = snapInsideEnd(Math.max(minTop, input.viewportHeight - inset));
    const availableWidth = Math.max(0, maxRight - minLeft);
    const availableHeight = Math.max(0, maxBottom - minTop);
    const minWidth = Math.min(
        availableWidth,
        snapInsideStart(Math.max(0, Number.isFinite(input.minWidth) ? input.minWidth : 0))
    );
    const minHeight = Math.min(
        availableHeight,
        snapInsideStart(Math.max(0, Number.isFinite(input.minHeight) ? input.minHeight : 0))
    );

    let left = startLeft;
    let right = startRight;
    let top = startTop;
    let bottom = startBottom;
    const deltaX = Number.isFinite(input.deltaX) ? input.deltaX : 0;
    const deltaY = Number.isFinite(input.deltaY) ? input.deltaY : 0;

    if (input.direction.includes('w')) {
        left = clamp(snap(startLeft + deltaX), minLeft, right - minWidth);
    } else if (input.direction.includes('e')) {
        right = clamp(snap(startRight + deltaX), left + minWidth, maxRight);
    }

    if (input.allowHeightOverride) {
        if (input.direction.includes('n')) {
            top = clamp(snap(startTop + deltaY), minTop, bottom - minHeight);
        } else if (input.direction.includes('s')) {
            bottom = clamp(snap(startBottom + deltaY), top + minHeight, maxBottom);
        }
    }

    return {
        left,
        top,
        width: right - left,
        height: bottom - top,
    };
}

export function resizeSearchHostFrame(input: {
    start: SearchPanelGeometry;
    direction: SearchPanelResizeDirection;
    deltaX: number;
    deltaY: number;
    workArea: SearchPanelWorkArea;
    scaleFactor: number;
    minWidth: number;
    minHeight: number;
    allowHeightOverride: boolean;
}): SearchPanelGeometry {
    const scaleFactor = input.scaleFactor;
    const outset = Math.ceil(SEARCH_WINDOW_VISUAL_OUTSET * scaleFactor);
    const horizontalOutsets = 2 * outset;
    const { position, size } = input.workArea;
    const frame = resizeSearchPanelFrame({
        ...input,
        startFrame: {
            left: (input.start.physicalOrigin.x - position.x) / scaleFactor,
            // The shared work area already contains the effective vertical panel insets.
            top:
                (input.start.physicalOrigin.y + SEARCH_WINDOW_TOP_INSET - position.y) / scaleFactor,
            width: (Math.ceil(input.start.width * scaleFactor) + horizontalOutsets) / scaleFactor,
            height: Math.ceil(input.start.height * scaleFactor) / scaleFactor,
        },
        viewportWidth: size.width / scaleFactor,
        viewportHeight: size.height / scaleFactor,
        minWidth: (Math.ceil(input.minWidth * scaleFactor) + horizontalOutsets) / scaleFactor,
        minHeight: Math.ceil(input.minHeight * scaleFactor) / scaleFactor,
        visualInset: 0,
    });
    return {
        width: (Math.round(frame.width * scaleFactor) - horizontalOutsets) / scaleFactor,
        height: Math.round(frame.height * scaleFactor) / scaleFactor,
        physicalOrigin: {
            x: Math.round(position.x + frame.left * scaleFactor),
            y: Math.round(position.y + frame.top * scaleFactor - SEARCH_WINDOW_TOP_INSET),
        },
    };
}

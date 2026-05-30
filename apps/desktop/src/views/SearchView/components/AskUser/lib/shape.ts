// Adapted from https://www.fluidfunctionalism.com/r/shape-context.json
// Single rounded mode only — pill mode and global R shortcut removed.

export interface ShapeClasses {
    item: string;
    bg: string;
    focusRing: string;
    mergedBg: string;
    container: string;
    button: string;
    input: string;
}

export const shape: ShapeClasses = {
    item: 'rounded-lg',
    bg: 'rounded-lg',
    focusRing: 'rounded-[10px]',
    mergedBg: 'rounded-lg',
    container: 'rounded-2xl',
    button: 'rounded-full',
    input: 'rounded-full',
};

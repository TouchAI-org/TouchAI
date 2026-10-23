// Copyright (c) 2026. 千诚. Licensed under GPL v3.

import { type ClassValue, clsx } from 'clsx';
import { extendTailwindMerge } from 'tailwind-merge';

/*
 * tailwind-merge only knows Tailwind's built-in scale. Any custom `--text-*`,
 * `--radius-*` or `--color-*` token we add is invisible to it, which has a
 * consequence that is easy to miss: a call site that overrides a primitive with
 * one of our own tokens does not win the merge, so both classes stay in the
 * output and the cascade decides instead.
 *
 * That matters because most call sites override primitives. The lists below
 * register the custom names so `cn()` keeps resolving conflicts the way the
 * components expect.
 *
 * Keep these in sync with apps/desktop/src/styles/tokens/. The token tests assert
 * the same names exist, so a mismatch shows up as a test failure rather than as a
 * style that quietly stops overriding.
 */
const CUSTOM_FONT_SIZES = [
    '3xs',
    '2xs',
    'caption',
    'dense',
    'compact',
    'reading',
    'subtitle',
    'title',
    'xs',
    'sm',
    'base',
    'lg',
    'xl',
    '2xl',
    '3xl',
];

const CUSTOM_RADII = [
    'xs',
    'sm',
    'md',
    'lg',
    'xl',
    '2xl',
    'action',
    'control',
    'card',
    'panel',
    'full',
    'none',
];

const CUSTOM_COLORS = [
    'canvas',
    'canvas-sunken',
    'surface',
    'surface-raised',
    'surface-sunken',
    'surface-hover',
    'surface-hover-soft',
    'surface-active',
    'surface-active-strong',
    'surface-selected',
    'card',
    'hover',
    'active',
    'text-primary',
    'text-secondary',
    'text-tertiary',
    'text-inverse',
    'border-subtle',
    'border-strong',
    'background',
    'background-primary',
    'foreground',
    'primary',
    'primary-foreground',
    'secondary',
    'secondary-foreground',
    'accent',
    'accent-foreground',
    'muted',
    'muted-foreground',
    'destructive',
    'destructive-foreground',
    'border',
    'input',
    'ring',
    'markdown-surface',
    'markdown-surface-soft',
    'markdown-surface-border',
    'code-inline-bg',
    'code-inline-text',
    'selection-bg',
    'selection-outline',
    'scrollbar-thumb',
    'scrollbar-thumb-hover',
    'overlay-fade',
];

const twMergeConfigured = extendTailwindMerge({
    extend: {
        classGroups: {
            'font-size': [{ text: CUSTOM_FONT_SIZES }],
            rounded: [{ rounded: CUSTOM_RADII }],
        },
        theme: {
            color: CUSTOM_COLORS,
        },
    },
});

export function cn(...inputs: ClassValue[]) {
    return twMergeConfigured(clsx(inputs));
}

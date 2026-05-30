// Adapted from upstream registry/default/lib/font-weight.ts
// Upstream uses Inter variable-font axes via font-variation-settings.
// Source Han Serif is not a variable font, so we map to plain font-weight values
// expressed as font-variation-settings strings (browsers fall back gracefully)
// AND parallel weight numbers for direct font-weight binding.

export const fontWeights = {
    normal: 400,
    medium: 500,
    semibold: 600,
    bold: 700,
} as const;

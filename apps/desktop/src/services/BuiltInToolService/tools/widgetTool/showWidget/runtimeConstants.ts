// Copyright (c) 2026. 千诚. Licensed under GPL v3

export const SHOW_WIDGET_TOOL_NAME = 'builtin__show_widget';
export const SHOW_WIDGET_ALLOWED_RESOURCE_HOSTS = [
    'cdnjs.cloudflare.com',
    'cdn.jsdelivr.net',
    'unpkg.com',
    'esm.sh',
] as const;

export type ShowWidgetThemeVarName =
    | '--color-background-primary'
    | '--color-background-secondary'
    | '--color-background-tertiary'
    | '--color-background-info'
    | '--color-background-danger'
    | '--color-background-success'
    | '--color-background-warning'
    | '--color-text-primary'
    | '--color-text-secondary'
    | '--color-text-tertiary'
    | '--color-text-info'
    | '--color-text-danger'
    | '--color-text-success'
    | '--color-text-warning'
    | '--color-border-primary'
    | '--color-border-secondary'
    | '--color-border-tertiary'
    | '--color-border-info'
    | '--color-border-danger'
    | '--color-border-success'
    | '--color-border-warning'
    | '--color-scrollbar-thumb'
    | '--color-scrollbar-thumb-hover'
    | '--font-sans'
    | '--font-serif'
    | '--font-mono'
    | '--border-radius-md'
    | '--border-radius-lg'
    | '--border-radius-xl';

export interface ColorRampStops {
    50: string;
    100: string;
    200: string;
    400: string;
    600: string;
    800: string;
    900: string;
}

export const SHOW_WIDGET_DRAFT_MIN_INTERVAL_MS = 150;
export const SHOW_WIDGET_FADE_IN_ANIMATION =
    'touchai-widget-fade-in var(--touchai-widget-duration-fast, 250ms) var(--touchai-widget-ease, cubic-bezier(0.22, 1, 0.36, 1))';
export const SHOW_WIDGET_MAX_WIDTH_PX = 680;
/**
 * Last-resort values for the widget theme variables.
 *
 * Every name here now resolves against a real token in
 * `apps/desktop/src/styles/tokens/`, so in practice the runtime copies the app's
 * values and these entries are never used. They stay as a guard for the case
 * where the stylesheet failed to load, and they are kept numerically identical to
 * the tokens so a fallback can never look different from the real thing.
 *
 * `tests/ci/design-widget-contract.test.ts` fails if a name listed here stops
 * existing in the token layer, which is what previously allowed this contract to
 * drift into a second, parallel palette.
 */
export const SHOW_WIDGET_THEME_FALLBACKS: Record<ShowWidgetThemeVarName, string> = {
    '--color-background-primary': 'rgba(251, 251, 246, 0.98)',
    '--color-background-secondary': 'rgba(246, 243, 238, 0.98)',
    '--color-background-tertiary': 'rgba(239, 235, 228, 0.96)',
    '--color-background-info': '#eff6ff',
    '--color-background-danger': '#fef2f2',
    '--color-background-success': '#f0fdf4',
    '--color-background-warning': '#fffbeb',
    '--color-text-primary': '#4a4039',
    '--color-text-secondary': '#6b5f54',
    '--color-text-tertiary': '#968b7d',
    '--color-text-info': '#1e40af',
    '--color-text-danger': '#991b1b',
    '--color-text-success': '#166534',
    '--color-text-warning': '#92400e',
    '--color-border-primary': 'rgba(95, 94, 90, 0.4)',
    '--color-border-secondary': 'rgba(95, 94, 90, 0.3)',
    '--color-border-tertiary': 'rgba(95, 94, 90, 0.15)',
    '--color-border-info': 'rgba(12, 68, 124, 0.35)',
    '--color-border-danger': 'rgba(121, 31, 31, 0.35)',
    '--color-border-success': 'rgba(39, 80, 10, 0.35)',
    '--color-border-warning': 'rgba(99, 56, 6, 0.35)',
    '--color-scrollbar-thumb': 'rgba(156, 163, 175, 0.4)',
    '--color-scrollbar-thumb-hover': 'rgba(156, 163, 175, 0.6)',
    '--font-sans':
        "-apple-system, BlinkMacSystemFont, 'Segoe UI', 'PingFang SC', 'Microsoft YaHei', sans-serif",
    '--font-serif': "'TouchAI Source Han Serif SC', 'Noto Serif SC', serif",
    '--font-mono': "'JetBrains Mono', 'Fira Code', 'Consolas', 'Monaco', monospace",
    '--border-radius-md': '10px',
    '--border-radius-lg': '12px',
    '--border-radius-xl': '16px',
};
export const SHOW_WIDGET_COLOR_RAMPS: Record<string, ColorRampStops> = {
    purple: {
        50: '#EEEDFE',
        100: '#CECBF6',
        200: '#AFA9EC',
        400: '#7F77DD',
        600: '#534AB7',
        800: '#3C3489',
        900: '#26215C',
    },
    teal: {
        50: '#E1F5EE',
        100: '#9FE1CB',
        200: '#5DCAA5',
        400: '#1D9E75',
        600: '#0F6E56',
        800: '#085041',
        900: '#04342C',
    },
    coral: {
        50: '#FAECE7',
        100: '#F5C4B3',
        200: '#F0997B',
        400: '#D85A30',
        600: '#993C1D',
        800: '#712B13',
        900: '#4A1B0C',
    },
    pink: {
        50: '#FBEAF0',
        100: '#F4C0D1',
        200: '#ED93B1',
        400: '#D4537E',
        600: '#993556',
        800: '#72243E',
        900: '#4B1528',
    },
    gray: {
        50: '#F1EFE8',
        100: '#D3D1C7',
        200: '#B4B2A9',
        400: '#888780',
        600: '#5F5E5A',
        800: '#444441',
        900: '#2C2C2A',
    },
    blue: {
        50: '#E6F1FB',
        100: '#B5D4F4',
        200: '#85B7EB',
        400: '#378ADD',
        600: '#185FA5',
        800: '#0C447C',
        900: '#042C53',
    },
    green: {
        50: '#EAF3DE',
        100: '#C0DD97',
        200: '#97C459',
        400: '#639922',
        600: '#3B6D11',
        800: '#27500A',
        900: '#173404',
    },
    amber: {
        50: '#FAEEDA',
        100: '#FAC775',
        200: '#EF9F27',
        400: '#BA7517',
        600: '#854F0B',
        800: '#633806',
        900: '#412402',
    },
    red: {
        50: '#FCEBEB',
        100: '#F7C1C1',
        200: '#F09595',
        400: '#E24B4A',
        600: '#A32D2D',
        800: '#791F1F',
        900: '#501313',
    },
};

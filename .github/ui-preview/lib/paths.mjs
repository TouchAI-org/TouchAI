/**
 * Decides whether a pull request can change what the desktop interface renders.
 *
 * A path counts only when it can change pixels, strings inside those pixels, or
 * the window that holds them. Tests, docs, and the official site never count,
 * even when they sit inside a UI folder.
 */

const UI_PATH_PATTERNS = [
    /^apps\/desktop\/src\/views\//,
    /^apps\/desktop\/src\/components\//,
    /^apps\/desktop\/src\/styles\//,
    /^apps\/desktop\/src\/i18n\//,
    /^apps\/desktop\/src\/assets\//,
    /^apps\/desktop\/src\/router\//,
    /^apps\/desktop\/index\.html$/,
    /^apps\/desktop\/src-tauri\/src\/core\/window\//,
    /^apps\/desktop\/src-tauri\/tauri\.conf\.json$/,
    /^apps\/desktop\/src-tauri\/tauri\.(linux|windows|macos)\.conf\.json$/,
];

const EXCLUDED_PATTERNS = [
    /^\.github\//,
    /^docs\//,
    /^apps\/desktop\/tests\//,
    /^apps\/desktop\/e2e-tests\//,
    /^apps\/desktop\/src-tauri\/tests\//,
    /\.(test|spec)\.[cm]?[jt]sx?$/,
    /\.md$/,
];

const I18N_PATTERN = /^apps\/desktop\/src\/i18n\//;
const WINDOW_PATTERN = /^apps\/desktop\/src-tauri\/(src\/core\/window\/|tauri[^/]*\.conf\.json$)/;
const SETTINGS_PATTERN = /^apps\/desktop\/src\/views\/SettingsView\//;
const SEARCH_PATTERN = /^apps\/desktop\/src\/views\/SearchView\//;

export function normalizePath(filePath) {
    return String(filePath ?? '')
        .replace(/\\/g, '/')
        .replace(/^\.\//, '');
}

export function isUiPath(filePath) {
    const normalized = normalizePath(filePath);

    if (!normalized) {
        return false;
    }

    if (EXCLUDED_PATTERNS.some((pattern) => pattern.test(normalized))) {
        return false;
    }

    return UI_PATH_PATTERNS.some((pattern) => pattern.test(normalized));
}

/**
 * @param {Array<string | { filename?: string }>} files
 */
export function classifyFiles(files) {
    const names = (files ?? [])
        .map((file) => normalizePath(typeof file === 'string' ? file : file?.filename))
        .filter(Boolean);
    const ui = names.filter((name) => isUiPath(name));

    return {
        files: names,
        ui,
        hasUiChange: ui.length > 0,
        touchedI18n: ui.some((name) => I18N_PATTERN.test(name)),
        touchedWindow: ui.some((name) => WINDOW_PATTERN.test(name)),
        touchedSettings: ui.some((name) => SETTINGS_PATTERN.test(name)),
        touchedSearch: ui.some((name) => SEARCH_PATTERN.test(name)),
    };
}

export const __patterns = { UI_PATH_PATTERNS, EXCLUDED_PATTERNS };

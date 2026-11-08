export const SETTINGS_SIDEBAR_COLLAPSED_WIDTH = 76;
export const SETTINGS_SIDEBAR_MIN_WIDTH = 216;
export const SETTINGS_SIDEBAR_DEFAULT_WIDTH = 240;
export const SETTINGS_SIDEBAR_MAX_WIDTH = 352;

export const SETTINGS_SECONDARY_SIDEBAR_MIN_WIDTH = 248;
export const SETTINGS_SECONDARY_SIDEBAR_DEFAULT_WIDTH = 264;
export const SETTINGS_SECONDARY_SIDEBAR_MAX_WIDTH = 336;

export const SETTINGS_LAYOUT_MIN_WIDTH = 920;
export const SETTINGS_DETAIL_PANEL_MIN_WIDTH = 360;
export const SETTINGS_RESIZE_KEYBOARD_STEP = 16;
export const SETTINGS_PRIMARY_SIDEBAR_RESIZE_EVENT = 'settings-primary-sidebar-resize';
export const SETTINGS_SECONDARY_PANEL_RESIZE_EVENT = 'settings-secondary-panel-resize';
const SETTINGS_WINDOW_SHELL_SELECTOR = '[data-testid="settings-window-shell"]';

export function readSettingsWindowContentWidth(): number {
    const shell = document.querySelector(SETTINGS_WINDOW_SHELL_SELECTOR);
    if (shell instanceof HTMLElement) {
        const rectWidth = shell.getBoundingClientRect().width;
        if (Number.isFinite(rectWidth) && rectWidth > 0) {
            return rectWidth;
        }
    }

    return window.innerWidth;
}

/**
 * Re-clamp the settings columns when the visible shell changes size without a
 * native window resize. Maximizing or restoring changes the 24 px frame padding
 * after the resize event, so listening to the shell itself covers that late
 * layout change.
 */
export function observeSettingsWindowContentWidth(onChange: () => void): () => void {
    if (typeof ResizeObserver !== 'function') {
        return () => {};
    }

    const shell = document.querySelector(SETTINGS_WINDOW_SHELL_SELECTOR);
    if (!(shell instanceof HTMLElement)) {
        return () => {};
    }

    let lastWidth = readSettingsWindowContentWidth();
    const observer = new ResizeObserver(() => {
        const width = readSettingsWindowContentWidth();
        if (width === lastWidth) return;
        lastWidth = width;
        onChange();
    });
    observer.observe(shell);

    return () => observer.disconnect();
}

interface SettingsSidebarClampOptions {
    availableWidth?: number;
    minDetailPanelWidth?: number;
    primarySidebarWidth?: number;
    secondaryPanelWidth?: number;
}

function finiteOr(value: number | undefined, fallback: number): number {
    return typeof value === 'number' && Number.isFinite(value) ? value : fallback;
}

function calculateLayoutAwareMaxWidth(
    baseMaxWidth: number,
    currentPanelMinWidth: number,
    otherPanelWidth: number | undefined,
    options: SettingsSidebarClampOptions | undefined
): number {
    const availableWidth = finiteOr(options?.availableWidth, Number.POSITIVE_INFINITY);
    const minDetailPanelWidth = finiteOr(
        options?.minDetailPanelWidth,
        SETTINGS_DETAIL_PANEL_MIN_WIDTH
    );
    const occupiedByOtherPanel = finiteOr(otherPanelWidth, 0);
    const layoutMaxWidth = availableWidth - occupiedByOtherPanel - minDetailPanelWidth;

    return Math.max(currentPanelMinWidth, Math.min(baseMaxWidth, Math.floor(layoutMaxWidth)));
}

export function getSettingsSidebarMaxWidth(options?: SettingsSidebarClampOptions): number {
    return calculateLayoutAwareMaxWidth(
        SETTINGS_SIDEBAR_MAX_WIDTH,
        SETTINGS_SIDEBAR_MIN_WIDTH,
        options?.secondaryPanelWidth,
        options
    );
}

export function getSettingsSecondarySidebarMaxWidth(options?: SettingsSidebarClampOptions): number {
    return calculateLayoutAwareMaxWidth(
        SETTINGS_SECONDARY_SIDEBAR_MAX_WIDTH,
        SETTINGS_SECONDARY_SIDEBAR_MIN_WIDTH,
        options?.primarySidebarWidth,
        options
    );
}

export function clampSettingsSidebarWidth(
    width: number,
    options?: SettingsSidebarClampOptions
): number {
    if (!Number.isFinite(width)) {
        return SETTINGS_SIDEBAR_DEFAULT_WIDTH;
    }

    const maxWidth = getSettingsSidebarMaxWidth(options);

    return Math.min(maxWidth, Math.max(SETTINGS_SIDEBAR_MIN_WIDTH, Math.round(width)));
}

export function calculateSettingsSidebarWidth(
    initialWidth: number,
    startClientX: number,
    currentClientX: number,
    options?: SettingsSidebarClampOptions
): number {
    return clampSettingsSidebarWidth(initialWidth + currentClientX - startClientX, options);
}

export function clampSettingsSecondarySidebarWidth(
    width: number,
    options?: SettingsSidebarClampOptions
): number {
    if (!Number.isFinite(width)) {
        return SETTINGS_SECONDARY_SIDEBAR_DEFAULT_WIDTH;
    }

    const maxWidth = getSettingsSecondarySidebarMaxWidth(options);

    return Math.min(maxWidth, Math.max(SETTINGS_SECONDARY_SIDEBAR_MIN_WIDTH, Math.round(width)));
}

export function calculateSettingsSecondarySidebarWidth(
    initialWidth: number,
    startClientX: number,
    currentClientX: number,
    options?: SettingsSidebarClampOptions
): number {
    return clampSettingsSecondarySidebarWidth(
        initialWidth + currentClientX - startClientX,
        options
    );
}

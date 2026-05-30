import {
    calculateSettingsSecondarySidebarWidth,
    calculateSettingsSidebarWidth,
    clampSettingsSecondarySidebarWidth,
    clampSettingsSidebarWidth,
    SETTINGS_DETAIL_PANEL_MIN_WIDTH,
    SETTINGS_LAYOUT_MIN_WIDTH,
    SETTINGS_SECONDARY_SIDEBAR_DEFAULT_WIDTH,
    SETTINGS_SECONDARY_SIDEBAR_MAX_WIDTH,
    SETTINGS_SECONDARY_SIDEBAR_MIN_WIDTH,
    SETTINGS_SIDEBAR_DEFAULT_WIDTH,
    SETTINGS_SIDEBAR_MAX_WIDTH,
    SETTINGS_SIDEBAR_MIN_WIDTH,
} from '@/views/SettingsView/settingsSidebarLayout';

describe('settingsSidebarLayout', () => {
    it('keeps the default width compact and above the minimum width', () => {
        expect(SETTINGS_SIDEBAR_DEFAULT_WIDTH).toBeGreaterThanOrEqual(SETTINGS_SIDEBAR_MIN_WIDTH);
        expect(SETTINGS_SIDEBAR_DEFAULT_WIDTH).toBe(240);
        expect(SETTINGS_SIDEBAR_MIN_WIDTH).toBe(216);
    });

    it('clamps the sidebar width to the supported range', () => {
        expect(clampSettingsSidebarWidth(Number.NaN)).toBe(SETTINGS_SIDEBAR_DEFAULT_WIDTH);
        expect(clampSettingsSidebarWidth(SETTINGS_SIDEBAR_MIN_WIDTH - 40)).toBe(
            SETTINGS_SIDEBAR_MIN_WIDTH
        );
        expect(clampSettingsSidebarWidth(SETTINGS_SIDEBAR_MAX_WIDTH + 40)).toBe(
            SETTINGS_SIDEBAR_MAX_WIDTH
        );
        expect(clampSettingsSidebarWidth(260)).toBe(260);
    });

    it('calculates drag width from the initial width and pointer delta', () => {
        expect(calculateSettingsSidebarWidth(260, 100, 132)).toBe(292);
        expect(calculateSettingsSidebarWidth(260, 100, -200)).toBe(SETTINGS_SIDEBAR_MIN_WIDTH);
        expect(calculateSettingsSidebarWidth(260, 100, 600)).toBe(SETTINGS_SIDEBAR_MAX_WIDTH);
    });

    it('clamps secondary settings panels independently from the main sidebar', () => {
        expect(clampSettingsSecondarySidebarWidth(Number.NaN)).toBe(
            SETTINGS_SECONDARY_SIDEBAR_DEFAULT_WIDTH
        );
        expect(SETTINGS_SECONDARY_SIDEBAR_MIN_WIDTH).toBe(248);
        expect(SETTINGS_SECONDARY_SIDEBAR_DEFAULT_WIDTH).toBe(264);
        expect(clampSettingsSecondarySidebarWidth(SETTINGS_SECONDARY_SIDEBAR_MIN_WIDTH - 80)).toBe(
            SETTINGS_SECONDARY_SIDEBAR_MIN_WIDTH
        );
        expect(clampSettingsSecondarySidebarWidth(SETTINGS_SECONDARY_SIDEBAR_MAX_WIDTH + 80)).toBe(
            SETTINGS_SECONDARY_SIDEBAR_MAX_WIDTH
        );
        expect(clampSettingsSecondarySidebarWidth(300)).toBe(300);
    });

    it('calculates secondary panel drag width from the initial width and pointer delta', () => {
        expect(calculateSettingsSecondarySidebarWidth(264, 100, 150)).toBe(314);
        expect(calculateSettingsSecondarySidebarWidth(264, 100, -100)).toBe(
            SETTINGS_SECONDARY_SIDEBAR_MIN_WIDTH
        );
        expect(calculateSettingsSecondarySidebarWidth(264, 100, 500)).toBe(
            SETTINGS_SECONDARY_SIDEBAR_MAX_WIDTH
        );
    });

    it('keeps resizable columns from consuming the detail panel at the minimum layout width', () => {
        const sidebarWidth = clampSettingsSidebarWidth(SETTINGS_SIDEBAR_MAX_WIDTH, {
            availableWidth: SETTINGS_LAYOUT_MIN_WIDTH,
            secondaryPanelWidth: SETTINGS_SECONDARY_SIDEBAR_DEFAULT_WIDTH,
        });
        const secondaryPanelWidth = clampSettingsSecondarySidebarWidth(
            SETTINGS_SECONDARY_SIDEBAR_MAX_WIDTH,
            {
                availableWidth: SETTINGS_LAYOUT_MIN_WIDTH,
                primarySidebarWidth: sidebarWidth,
            }
        );

        expect(sidebarWidth + secondaryPanelWidth).toBeLessThanOrEqual(
            SETTINGS_LAYOUT_MIN_WIDTH - SETTINGS_DETAIL_PANEL_MIN_WIDTH
        );
    });
});

import { createSettingsPanelFixture } from '@tests/utils/settingsPanel';
import { afterEach, describe, expect, it } from 'vitest';
import { ref } from 'vue';

import {
    applyGeneralSettingValue,
    applyPersistedGeneralSettingValue,
    cloneGeneralSettingsSnapshot,
    createDefaultGeneralSettings,
    getGeneralSettingDefinition,
    getGeneralSettingEventValue,
    serializeGeneralSetting,
} from '@/app/api/settings/preferences';
import { createGeneralSettingsComputedRefs } from '@/stores/settingBindings';

let fixture: Awaited<ReturnType<typeof createSettingsPanelFixture>> | undefined;
afterEach(async () => {
    await fixture?.dispose();
    fixture = undefined;
});

describe('given ordinary preferences have public normalization and projection contracts', () => {
    it.each([
        [null, 880],
        ['', 880],
        ['broken', 880],
        ['Infinity', 880],
        ['602', 640],
        ['1198', 1200],
        ['2800', 2400],
    ] as const)(
        'user loads a saved width of %s and gets a reading limit of %i pixels',
        (raw, width) => {
            const settings = createDefaultGeneralSettings();
            applyPersistedGeneralSettingValue(settings, 'conversation_content_width', raw);
            expect(settings.conversationContentWidth).toBe(width);
            expect(cloneGeneralSettingsSnapshot(settings).conversationContentWidth).toBe(width);
        }
    );

    it('user changes the reading width and another window receives the normalized saved preference', async () => {
        fixture = await createSettingsPanelFixture({
            values: { language: 'en-US', conversation_content_width: '1600' },
        });
        expect(fixture.preferences.conversationContentWidth).toBe(1600);
        await fixture.preferences.updateConversationContentWidth(1198);
        expect(fixture.saved('conversation_content_width')).toBe('1200');
        expect(fixture.client.settings.getSnapshot().conversationContentWidth).toBe(1200);
        expect(fixture.window.settings.getSnapshot().conversationContentWidth).toBe(1200);
        expect(fixture.preferences.conversationContentWidth).toBe(1200);
    });

    it('user opens preferences without receiving browser or search business configuration', () => {
        const settings = createDefaultGeneralSettings();
        expect(settings).not.toHaveProperty('browserSettings');
        expect(settings).not.toHaveProperty('searchSettings');
        expect(getGeneralSettingDefinition('browser_settings' as never)).toBeNull();
        expect(getGeneralSettingDefinition('search_settings' as never)).toBeNull();
    });

    it('user applies scalar choices and sees their compatible serialized and event values', () => {
        const settings = createDefaultGeneralSettings();
        applyGeneralSettingValue(settings, 'start_on_boot', 'true');
        expect(settings.startOnBoot).toBe(true);
        expect(serializeGeneralSetting(settings, 'start_on_boot')).toBe('true');
        expect(getGeneralSettingEventValue(settings, 'start_on_boot')).toBe(true);
        applyGeneralSettingValue(settings, 'search_window_size_preset', 'large');
        expect(settings.searchWindowSizePreset).toBe('large');
        expect(settings.searchWindowDefaultSize).toMatchObject({ width: 938 });
    });

    it('user reopens invalid saved scalar choices and receives the existing defaults', () => {
        const settings = createDefaultGeneralSettings();
        applyPersistedGeneralSettingValue(settings, 'output_scroll_behavior', 'invalid');
        applyPersistedGeneralSettingValue(settings, 'search_window_size_preset', 'invalid');
        applyPersistedGeneralSettingValue(settings, 'app_update_auto_check', 'false');
        expect(settings.outputScrollBehavior).toBe('follow_output');
        expect(settings.searchWindowSizePreset).toBe('normal');
        expect(settings.searchWindowDefaultSize).toMatchObject({ width: 750 });
        expect(settings.appUpdateAutoCheck).toBe(false);
    });

    it('user edits a cloned projection without changing another view nested preferences', () => {
        const settings = createDefaultGeneralSettings();
        const clone = cloneGeneralSettingsSnapshot(settings);
        clone.searchKeybindings['search.history.open'] = 'Mod+J';
        clone.searchWindowDefaultSize.width = 900;
        clone.searchWindowAutoHideDelay = '60s';
        expect(settings.searchKeybindings['search.history.open']).not.toBe('Mod+J');
        expect(settings.searchWindowDefaultSize.width).toBe(750);
        expect(settings.searchWindowAutoHideDelay).toBe('immediate');
    });

    it('user changes the projected shortcut and a computed control reflects that choice', () => {
        const settings = ref(createDefaultGeneralSettings());
        const controls = createGeneralSettingsComputedRefs(settings);
        expect(controls.globalShortcut.value).toBe('Alt+Space');
        settings.value.globalShortcut = 'Ctrl+Space';
        expect(controls.globalShortcut.value).toBe('Ctrl+Space');
    });

    it('user changes preferences through store commands and production main commits normalized values', async () => {
        fixture = await createSettingsPanelFixture({ values: { language: 'en-US' } });
        await fixture.preferences.updateAnimationSpeed('faster');
        await fixture.preferences.updateStartMinimized(false);
        await fixture.preferences.updateOutputScrollBehavior('stay_position');
        await fixture.preferences.updateSearchWindowSizePreset('large');
        expect(fixture.saved('animation_speed')).toBe('faster');
        expect(fixture.saved('start_minimized')).toBe('false');
        expect(fixture.saved('output_scroll_behavior')).toBe('stay_position');
        expect(fixture.saved('search_window_size_preset')).toBe('large');
        expect(fixture.client.settings.getSnapshot()).toMatchObject({
            animationSpeed: 'faster',
            startMinimized: false,
            outputScrollBehavior: 'stay_position',
            searchWindowDefaultSize: { width: 938 },
        });
    });

    it('user selects a delayed auto-hide policy and both stores expose the same preference', async () => {
        fixture = await createSettingsPanelFixture();
        const settings = ref(createDefaultGeneralSettings());
        const controls = createGeneralSettingsComputedRefs(settings);
        expect(controls.searchWindowAutoHideDelay.value).toBe('immediate');

        settings.value.searchWindowAutoHideDelay = '30s';
        expect(controls.searchWindowAutoHideDelay.value).toBe('30s');

        await fixture.preferences.updateSearchWindowAutoHideDelay('15s');
        expect(fixture.saved('search_window_auto_hide_delay')).toBe('15s');
        expect(fixture.client.settings.getSnapshot().searchWindowAutoHideDelay).toBe('15s');
        expect(fixture.window.settings.getSnapshot().searchWindowAutoHideDelay).toBe('15s');
        expect(fixture.preferences.searchWindowAutoHideDelay).toBe('15s');
    });

    it('user changes language through a client and another window observes the committed preference', async () => {
        fixture = await createSettingsPanelFixture({ values: { language: 'zh-CN' } });
        await fixture.preferences.updateLanguage('en-US');
        expect(fixture.saved('language')).toBe('en-US');
        expect(fixture.window.settings.getSnapshot().language).toBe('en-US');
        expect(fixture.preferences.language).toBe('en-US');
    });
});

import * as messages from '@/app/api/settings/messages';
import { createToolSettingsApi, toolSettingsSections } from '@/app/workflows/settings/tools';
import { setLocale, t } from '@/i18n';
import {
    assertDeliverableSend,
    createSettingsPersistence,
    parseSettingsWireMessage,
    SETTINGS_TRANSPORT_EVENT,
    SettingsService,
} from '@/modules/settings';
import {
    type GeneralSettingKey,
    getGeneralSettingDefinition,
    type SettingsApi,
    SettingsErrorCode,
    SettingsServiceError,
} from '@/modules/settings/public';
import { discoverInstalledBrowsers, getDefaultBrowserDataPath } from '@/modules/tools';
import { log } from '@/platform/diagnostics';
import { native } from '@/platform/native';
import { createWindowChannel } from '@/platform/windows/channel';
import { pickDirectory, pickFile } from '@/platform/windows/dialog';
import { requireMainExecutionHost } from '@/platform/windows/execution';

function requirePreferenceKey(key: GeneralSettingKey): void {
    if (!getGeneralSettingDefinition(key)) {
        throw new SettingsServiceError(
            SettingsErrorCode.UnknownKey,
            messages.mutationFailedMessage()
        );
    }
}

/** Bootstrap captures the native label once; route changes cannot promote a client. */
export function assembleSettingsWindow(label: string | null) {
    if (label === 'main') requireMainExecutionHost();
    const service = new SettingsService({
        transport: createWindowChannel({
            event: SETTINGS_TRANSPORT_EVENT,
            label: label ?? 'unknown',
            parse: parseSettingsWireMessage,
            validateSend: assertDeliverableSend,
        }),
        effects: {
            isAutostartEnabled: native.autostart.isAutostartEnabled,
            setAutostart: (enabled) =>
                enabled ? native.autostart.enableAutostart() : native.autostart.disableAutostart(),
            registerGlobalShortcut: native.shortcut.registerGlobalShortcut,
            setSearchWindowDefaults: async (size) => {
                await native.window.setSearchWindowDefaults(size);
            },
            applyLanguage: setLocale,
        },
        persistence: createSettingsPersistence(),
        messages,
        diagnostics: log,
        sections: toolSettingsSections(),
        role: label === 'main' ? 'owner' : 'client',
    });
    const api = Object.freeze<SettingsApi>({
        initialize: service.initialize.bind(service),
        refresh: service.refresh.bind(service),
        getSnapshot: service.getSnapshot.bind(service),
        subscribe: service.subscribe.bind(service),
        async readEffectiveValue(key) {
            requirePreferenceKey(key);
            return service.readEffectiveValue(key);
        },
        async mutate(key, value) {
            requirePreferenceKey(key);
            return service.mutate(key, value);
        },
    });
    return Object.freeze({
        api,
        toolSettings:
            label === 'settings' || label === 'main'
                ? createToolSettingsApi(service, {
                      discoverInstalledBrowsers,
                      getDefaultBrowserDataPath,
                      pickBrowserDataPath: (defaultPath) =>
                          pickDirectory({
                              defaultPath,
                              title: t('settings.browser.browserDataPath.pick'),
                          }),
                      pickBrowserExecutable: (defaultPath) =>
                          pickFile({
                              defaultPath,
                              title: t('settings.browser.executablePath.pick'),
                          }),
                      pickBashWorkingDirectory: (defaultPath) =>
                          pickDirectory({
                              defaultPath: defaultPath?.trim() || undefined,
                              title: t('settings.builtInTools.bash.chooseDirectory'),
                          }),
                  })
                : undefined,
        dispose: service.dispose.bind(service),
    });
}

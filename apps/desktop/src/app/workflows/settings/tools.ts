import type { BrowserSettingsApi } from '@/app/api/settings/browser';
import type { ToolSettingsApi } from '@/app/api/settings/tools';
import type { SettingsSection, SettingsService } from '@/modules/settings';
import { SettingsErrorCode, SettingsServiceError } from '@/modules/settings';
import type { BrowserSettingsConfig, SearchSettingsConfig } from '@/modules/tools/public';
import {
    BROWSER_SETTINGS_KEY,
    parseBrowserSettingsConfig,
    parseSearchSettingsConfig,
    SEARCH_SETTINGS_KEY,
    serializeBrowserSettingsConfig,
    serializeSearchSettingsConfig,
} from '@/modules/tools/public';

/** Only the owning modules know these DTOs; Settings supplies its existing serialized writer. */
export function toolSettingsSections(): SettingsSection[] {
    return [
        {
            key: BROWSER_SETTINGS_KEY,
            stateKey: 'browserSettings',
            parse: parseBrowserSettingsConfig,
            serialize: (value) => serializeBrowserSettingsConfig(value as BrowserSettingsConfig),
        },
        {
            key: SEARCH_SETTINGS_KEY,
            stateKey: 'searchSettings',
            parse: parseSearchSettingsConfig,
            serialize: (value) => serializeSearchSettingsConfig(value as SearchSettingsConfig),
        },
    ];
}

export function createToolSettingsApi(
    settings: Pick<
        SettingsService,
        'getSectionSnapshot' | 'initialize' | 'refresh' | 'mutate' | 'subscribe'
    >,
    browser: BrowserSettingsApi & Pick<ToolSettingsApi, 'pickBashWorkingDirectory'>
): ToolSettingsApi {
    const read = settings.getSectionSnapshot.bind(settings);
    const initialize = settings.initialize.bind(settings);
    const mutate = settings.mutate.bind(settings);
    const subscribe = settings.subscribe.bind(settings);
    async function update(key: string, value: string) {
        await initialize();
        const result = await mutate(key, value);
        if (result.status !== 'committed')
            throw new SettingsServiceError(
                result.code ?? SettingsErrorCode.PersistenceFailed,
                result.message
            );
    }
    return Object.freeze({
        discoverInstalledBrowsers: browser.discoverInstalledBrowsers.bind(browser),
        getDefaultBrowserDataPath: browser.getDefaultBrowserDataPath.bind(browser),
        pickBrowserDataPath: browser.pickBrowserDataPath.bind(browser),
        pickBrowserExecutable: browser.pickBrowserExecutable.bind(browser),
        pickBashWorkingDirectory: browser.pickBashWorkingDirectory.bind(browser),
        initialize,
        refresh: settings.refresh.bind(settings),
        getBrowserSettings: () => read(BROWSER_SETTINGS_KEY) as BrowserSettingsConfig,
        getSearchSettings: () => read(SEARCH_SETTINGS_KEY) as SearchSettingsConfig,
        updateBrowserSettings: (value: BrowserSettingsConfig) =>
            update(BROWSER_SETTINGS_KEY, serializeBrowserSettingsConfig(value)),
        updateSearchSettings: (value: SearchSettingsConfig) =>
            update(SEARCH_SETTINGS_KEY, serializeSearchSettingsConfig(value)),
        subscribe: (listener: () => void) =>
            subscribe((notice) => {
                if (
                    !notice.changedKeys.length ||
                    notice.changedKeys.some(
                        (key) => key === BROWSER_SETTINGS_KEY || key === SEARCH_SETTINGS_KEY
                    )
                )
                    listener();
            }),
    });
}

import { defineStore } from 'pinia';
import { onScopeDispose, ref } from 'vue';

import {
    type BrowserSettingsConfig,
    parseBrowserSettingsConfig,
    parseSearchSettingsConfig,
    type SearchSettingsConfig,
    serializeBrowserSettingsConfig,
    serializeSearchSettingsConfig,
    useToolSettingsApi,
} from '@/app/api/settings/tools';
import { createBrowserRuntimeCache } from '@/views/SettingsView/components/Browser/runtimeCache';

/** Editable projections; bootstrap, not a store or panel, owns the writer/client. */
export const useToolSettingsStore = defineStore('tool-settings', () => {
    const api = useToolSettingsApi();
    const browserQueries = createBrowserRuntimeCache({
        installed: api.discoverInstalledBrowsers,
        defaultDataPath: api.getDefaultBrowserDataPath,
    });
    const browserSettings = ref(api.getBrowserSettings());
    const searchSettings = ref(api.getSearchSettings());
    const initialized = ref(false);
    let initialization: Promise<void> | undefined;
    let unsubscribe: (() => void) | undefined;
    let disposed = false;
    let browserToken = 0;
    let searchToken = 0;
    let pendingBrowser: BrowserSettingsConfig | undefined;
    let pendingSearch: SearchSettingsConfig | undefined;

    function mirror() {
        if (disposed) return;
        const browser = pendingBrowser ?? api.getBrowserSettings();
        const search = pendingSearch ?? api.getSearchSettings();
        if (JSON.stringify(browserSettings.value) !== JSON.stringify(browser))
            browserSettings.value = browser;
        if (JSON.stringify(searchSettings.value) !== JSON.stringify(search))
            searchSettings.value = search;
    }

    async function initialize() {
        if (disposed) throw new Error('TOOLS_SETTINGS_CLIENT_UNAVAILABLE');
        if (initialized.value) return;
        if (initialization) return initialization;
        unsubscribe ??= api.subscribe(mirror);
        initialization = api
            .initialize()
            .then(() => {
                if (disposed) return;
                mirror();
                initialized.value = true;
            })
            .finally(() => {
                initialization = undefined;
            });
        return initialization;
    }

    async function refresh() {
        await initialize();
        await api.refresh();
        mirror();
    }

    async function updateBrowserSettings(value: BrowserSettingsConfig) {
        const token = ++browserToken;
        pendingBrowser = parseBrowserSettingsConfig(serializeBrowserSettingsConfig(value));
        mirror();
        try {
            await api.updateBrowserSettings(value);
        } finally {
            if (browserToken === token) {
                pendingBrowser = undefined;
                mirror();
            }
        }
    }

    async function updateSearchSettings(value: SearchSettingsConfig) {
        const token = ++searchToken;
        pendingSearch = parseSearchSettingsConfig(serializeSearchSettingsConfig(value));
        mirror();
        try {
            await api.updateSearchSettings(value);
        } finally {
            if (searchToken === token) {
                pendingSearch = undefined;
                mirror();
            }
        }
    }

    onScopeDispose(() => {
        disposed = true;
        unsubscribe?.();
        unsubscribe = undefined;
        pendingBrowser = undefined;
        pendingSearch = undefined;
    });
    return {
        browserSettings,
        searchSettings,
        initialized,
        initialize,
        refresh,
        updateBrowserSettings,
        updateSearchSettings,
        loadInstalledBrowsers: browserQueries.installed,
        loadDefaultBrowserDataPath: browserQueries.defaultDataPath,
        pickBrowserDataPath: api.pickBrowserDataPath,
        pickBrowserExecutable: api.pickBrowserExecutable,
    };
});

import type { AppIconName } from '@components/appIconMap';

import { SEARCH_KEYBINDING_DEFINITIONS } from '@/config/searchKeybindings';
import { type MessageKey, t } from '@/i18n';
import { messages } from '@/i18n/messages';

import { flattenSettingsNavigation, type NavigationSection } from './settingsNavigation';

export interface SettingsSearchResult {
    id: string;
    section: NavigationSection;
    targetId?: string;
    label: string;
    description: string;
    sectionLabel: string;
    icon: AppIconName;
    /** All translations plus the section label; searched but never rendered. */
    haystack: string;
}

interface SearchItemDefinition {
    labelKey: MessageKey;
    descriptionKey?: MessageKey;
    targetId: string;
}

/**
 * Every translation of a message key, so a search matches what the user typed even when it
 * is not in the active interface language. Someone reading the Chinese UI still knows the
 * setting as "start minimized", and the reverse holds too.
 */
function translationsOf(key: MessageKey | undefined): string[] {
    if (!key) return [];

    return Object.values(messages)
        .map((dictionary) => dictionary[key])
        .filter((text): text is string => typeof text === 'string' && text.length > 0);
}

const settingDefinitions: Partial<Record<NavigationSection, SearchItemDefinition[]>> = {
    general: [
        { labelKey: 'settings.general.startOnBoot', targetId: 'start-on-boot' },
        { labelKey: 'settings.general.startMinimized', targetId: 'start-minimized' },
        { labelKey: 'settings.general.windowSize', targetId: 'window-size' },
        { labelKey: 'settings.general.outputScrollBehavior', targetId: 'output-scroll' },
        {
            labelKey: 'settings.general.interfaceLanguage',
            descriptionKey: 'settings.general.languageDescription',
            targetId: 'language',
        },
        { labelKey: 'settings.general.update.channelTitle', targetId: 'updates' },
        { labelKey: 'settings.general.update.channelRowLabel', targetId: 'update-channel' },
        { labelKey: 'settings.general.update.autoCheck', targetId: 'update-auto-check' },
    ],
    shortcuts: [
        {
            labelKey: 'settings.general.activationShortcut',
            descriptionKey: 'settings.general.activationShortcutDescription',
            targetId: 'activation-shortcut',
        },
        ...SEARCH_KEYBINDING_DEFINITIONS.map((definition) => ({
            labelKey: definition.labelKey,
            descriptionKey: definition.descriptionKey,
            targetId: definition.id,
        })),
    ],
    'ai-services': [
        { labelKey: 'settings.ai.providerConfigTitle', targetId: 'provider-config' },
        { labelKey: 'settings.ai.apiEndpoint', targetId: 'provider-endpoint' },
        { labelKey: 'settings.ai.apiKey', targetId: 'provider-api-key' },
        { labelKey: 'settings.ai.modelListTitle', targetId: 'models' },
        { labelKey: 'settings.ai.setDefaultModel', targetId: 'models' },
    ],
    search: [
        { labelKey: 'settings.search.defaultProvider', targetId: 'search-default-provider' },
        { labelKey: 'settings.search.maxResults', targetId: 'search-max-results' },
        { labelKey: 'settings.search.timeout', targetId: 'search-timeout' },
        { labelKey: 'settings.search.section.provider', targetId: 'search-providers' },
        { labelKey: 'settings.search.section.routing', targetId: 'search-routing' },
        { labelKey: 'settings.search.parallelProviders', targetId: 'search-parallelProviders' },
        { labelKey: 'settings.search.fallbackEnabled', targetId: 'search-fallbackEnabled' },
        {
            labelKey: 'settings.search.preferOfficialSources',
            targetId: 'search-preferOfficialSources',
        },
    ],
    browser: [
        { labelKey: 'settings.browser.browserDataPath', targetId: 'browser-data-path' },
        { labelKey: 'settings.browser.executablePath', targetId: 'browser-executable' },
        { labelKey: 'settings.browser.defaultHomepage', targetId: 'browser-homepage' },
        { labelKey: 'settings.browser.defaultMode', targetId: 'browser-mode' },
        { labelKey: 'settings.browser.screenshotAttachment', targetId: 'browser-screenshot' },
        { labelKey: 'settings.browser.permissionMode', targetId: 'browser-permission-mode' },
        {
            labelKey: 'settings.browser.existingSessionPolicy',
            targetId: 'browser-existing-session',
        },
        { labelKey: 'settings.browser.blockedDomains', targetId: 'browser-blocked-domains' },
        { labelKey: 'settings.browser.allowedDomains', targetId: 'browser-allowed-domains' },
        { labelKey: 'settings.browser.fingerprintProfile', targetId: 'browser-fingerprint' },
        { labelKey: 'settings.browser.localeTimezone', targetId: 'browser-locale-timezone' },
        {
            labelKey: 'settings.browser.userAgent',
            descriptionKey: 'settings.browser.userAgent.description',
            targetId: 'browser-user-agent',
        },
        { labelKey: 'settings.browser.windowSize', targetId: 'browser-window-size' },
    ],
    'data-management': [
        { labelKey: 'settings.dataManagement.stats', targetId: 'data-stats' },
        { labelKey: 'settings.dataManagement.clearAllSessions', targetId: 'data-clear-sessions' },
        { labelKey: 'settings.dataManagement.clearAllMessages', targetId: 'data-clear-messages' },
        { labelKey: 'settings.dataManagement.clearSessionTurns', targetId: 'data-clear-turns' },
        { labelKey: 'settings.dataManagement.modelDatabase', targetId: 'model-database' },
        { labelKey: 'settings.dataManagement.exportSettings', targetId: 'export-settings' },
        { labelKey: 'settings.dataManagement.importSettings', targetId: 'import-settings' },
    ],
};

export function searchSettings(query: string): SettingsSearchResult[] {
    const tokens = query.normalize('NFKC').trim().toLocaleLowerCase().split(/\s+/).filter(Boolean);
    if (!tokens.length) return [];

    const results = flattenSettingsNavigation().flatMap((section) => {
        const common = { section: section.id, sectionLabel: section.label, icon: section.icon };
        const sectionResult: SettingsSearchResult = {
            ...common,
            id: section.id,
            label: section.label,
            description: section.description,
            haystack: `${section.label} ${section.description}`,
        };
        return [
            sectionResult,
            ...(settingDefinitions[section.id] ?? []).map((definition) => ({
                ...common,
                id: `${section.id}:${definition.labelKey}`,
                targetId: definition.targetId,
                label: t(definition.labelKey),
                description: definition.descriptionKey ? t(definition.descriptionKey) : '',
                // Every translation joins the searchable text, so a query typed in another
                // language still finds the row that is displayed in the active one.
                haystack: [
                    ...translationsOf(definition.labelKey),
                    ...translationsOf(definition.descriptionKey),
                    section.label,
                ].join(' '),
            })),
        ];
    });

    return results
        .map((result) => {
            const label = result.label.normalize('NFKC').toLocaleLowerCase();
            const haystack = result.haystack.normalize('NFKC').toLocaleLowerCase();
            const score = tokens.every((token) => haystack.includes(token))
                ? tokens.reduce((total, token) => total + (label.includes(token) ? 2 : 1), 0)
                : 0;
            return { result, score };
        })
        .filter(({ score }) => score > 0)
        .sort((left, right) => right.score - left.score)
        .map(({ result }) => result);
}

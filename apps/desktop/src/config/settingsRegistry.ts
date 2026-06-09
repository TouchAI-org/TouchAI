import type { AppIconName } from '@components/appIconMap';

import {
    BROWSER_SETTINGS_KEY,
    type BrowserSettingsConfig,
    DEFAULT_BROWSER_SETTINGS,
    getDefaultHomepageError,
    parseBrowserSettingsConfig,
    serializeBrowserSettingsConfig,
} from '@/config/browserSettings';
import {
    DEFAULT_SEARCH_SETTINGS,
    parseSearchSettingsConfig,
    SEARCH_PROVIDER_API_KEY_REQUIREMENTS,
    SEARCH_PROVIDER_ENDPOINT_REQUIREMENTS,
    SEARCH_PROVIDER_IDS,
    SEARCH_SETTINGS_KEY,
    type SearchSettingsConfig,
    serializeSearchSettingsConfig,
} from '@/config/searchSettings';
import type { MessageKey } from '@/i18n';

export interface SettingsValidationIssue {
    path: string;
    message: string;
}

export interface JsonSettingsSection<T> {
    key: string;
    stateKey: string;
    defaultValue: T;
    parse(raw: string | null): T;
    serialize(value: T): string;
}

export type RegisteredJsonSettingsValue = BrowserSettingsConfig | SearchSettingsConfig;

export type JsonSettingsKey = typeof BROWSER_SETTINGS_KEY | typeof SEARCH_SETTINGS_KEY;
export type JsonSettingsStateKey = 'browserSettings' | 'searchSettings';

export interface RegisteredJsonSettingsSection {
    key: JsonSettingsKey;
    stateKey: JsonSettingsStateKey;
    defaultValue: RegisteredJsonSettingsValue;
    parse(raw: string | null): RegisteredJsonSettingsValue;
    serialize(value: RegisteredJsonSettingsValue): string;
    validate(value: RegisteredJsonSettingsValue): SettingsValidationIssue[];
    ui: {
        sectionId: 'browser' | 'search';
        icon: AppIconName;
        labelKey: MessageKey;
        descriptionKey: MessageKey;
        navigationOrder: number;
    };
}

export const JSON_SETTINGS_SECTIONS: readonly RegisteredJsonSettingsSection[] = [
    {
        key: BROWSER_SETTINGS_KEY,
        stateKey: 'browserSettings',
        defaultValue: DEFAULT_BROWSER_SETTINGS,
        parse: parseBrowserSettingsConfig,
        serialize: (value) => serializeBrowserSettingsConfig(value as BrowserSettingsConfig),
        validate: (value) => validateBrowserSettings(value as BrowserSettingsConfig),
        ui: {
            sectionId: 'browser',
            icon: 'globe',
            labelKey: 'settings.nav.browser.label',
            descriptionKey: 'settings.nav.browser.description',
            navigationOrder: 20,
        },
    },
    {
        key: SEARCH_SETTINGS_KEY,
        stateKey: 'searchSettings',
        defaultValue: DEFAULT_SEARCH_SETTINGS,
        parse: parseSearchSettingsConfig,
        serialize: (value) => serializeSearchSettingsConfig(value as SearchSettingsConfig),
        validate: (value) => validateSearchSettings(value as SearchSettingsConfig),
        ui: {
            sectionId: 'search',
            icon: 'search',
            labelKey: 'settings.nav.search.label',
            descriptionKey: 'settings.nav.search.description',
            navigationOrder: 10,
        },
    },
] as const;

export function findJsonSettingsSection(key: string): RegisteredJsonSettingsSection | null {
    return JSON_SETTINGS_SECTIONS.find((section) => section.key === key) ?? null;
}

export function cloneJsonSettingsDefault(
    section: RegisteredJsonSettingsSection
): RegisteredJsonSettingsValue {
    return section.parse(section.serialize(section.defaultValue));
}

export function parseJsonSettingsValue(
    section: RegisteredJsonSettingsSection,
    value: unknown
): RegisteredJsonSettingsValue {
    return section.parse(typeof value === 'string' ? value : null);
}

export function serializeJsonSettingsValue(
    section: RegisteredJsonSettingsSection,
    value: RegisteredJsonSettingsValue
): string {
    return section.serialize(value);
}

export function validateJsonSettingsValue(
    section: RegisteredJsonSettingsSection,
    value: RegisteredJsonSettingsValue
): SettingsValidationIssue[] {
    return section.validate(value);
}

function validateBrowserSettings(value: BrowserSettingsConfig): SettingsValidationIssue[] {
    const defaultHomepageError = getDefaultHomepageError(value);
    return defaultHomepageError ? [{ path: 'defaultHomepage', message: defaultHomepageError }] : [];
}

function validateSearchSettings(value: SearchSettingsConfig): SettingsValidationIssue[] {
    const issues: SettingsValidationIssue[] = [];
    for (const providerId of SEARCH_PROVIDER_IDS) {
        const provider = value.providers[providerId];
        if (!provider?.enabled) {
            continue;
        }

        if (SEARCH_PROVIDER_API_KEY_REQUIREMENTS[providerId] === 'required' && !provider.apiKey) {
            issues.push({
                path: `providers.${providerId}.apiKey`,
                message: `${providerId} requires an API key before it can be enabled.`,
            });
        }

        if (
            SEARCH_PROVIDER_ENDPOINT_REQUIREMENTS[providerId] === 'required' &&
            !provider.endpoint
        ) {
            issues.push({
                path: `providers.${providerId}.endpoint`,
                message: `${providerId} requires an endpoint before it can be enabled.`,
            });
        }
    }
    return issues;
}

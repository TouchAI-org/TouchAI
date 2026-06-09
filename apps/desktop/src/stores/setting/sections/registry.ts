import type { AppIconName } from '@components/appIconMap';

import type { MessageKey } from '@/i18n';
import {
    BROWSER_SETTINGS_KEY,
    BROWSER_SETTINGS_VERSION,
    type BrowserSettingsConfig,
    DEFAULT_BROWSER_SETTINGS,
    getDefaultHomepageError,
    parseBrowserSettingsConfig,
    serializeBrowserSettingsConfig,
} from '@/stores/setting/sections/browser';
import {
    DEFAULT_SEARCH_SETTINGS,
    parseSearchSettingsConfig,
    SEARCH_PROVIDER_API_KEY_REQUIREMENTS,
    SEARCH_PROVIDER_ENDPOINT_REQUIREMENTS,
    SEARCH_PROVIDER_IDS,
    SEARCH_SETTINGS_KEY,
    SEARCH_SETTINGS_VERSION,
    type SearchSettingsConfig,
    serializeSearchSettingsConfig,
} from '@/stores/setting/sections/search';

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
export type JsonSettingsComputedName = 'browserSettings' | 'searchSettings';
export type JsonSettingsUpdaterName = 'updateBrowserSettings' | 'updateSearchSettings';

export interface JsonSettingsStoreBinding {
    computedName: JsonSettingsComputedName;
    updaterName: JsonSettingsUpdaterName;
}

export interface RegisteredJsonSettingsSection {
    key: JsonSettingsKey;
    version: number;
    stateKey: JsonSettingsStateKey;
    defaultValue: RegisteredJsonSettingsValue;
    parse(raw: string | null): RegisteredJsonSettingsValue;
    serialize(value: RegisteredJsonSettingsValue): string;
    validate(value: RegisteredJsonSettingsValue): SettingsValidationIssue[];
    store: JsonSettingsStoreBinding;
    ui: {
        sectionId: 'browser' | 'search';
        icon: AppIconName;
        labelKey: MessageKey;
        descriptionKey: MessageKey;
        navigationOrder: number;
    };
}

interface JsonSettingsSectionDefinition<T extends RegisteredJsonSettingsValue> {
    key: JsonSettingsKey;
    version: number;
    stateKey: JsonSettingsStateKey;
    defaultValue: T;
    parse(raw: string | null): T;
    serialize(value: T): string;
    validate(value: T): SettingsValidationIssue[];
    store: JsonSettingsStoreBinding;
    ui: RegisteredJsonSettingsSection['ui'];
}

function defineJsonSettingsSection<T extends RegisteredJsonSettingsValue>(
    section: JsonSettingsSectionDefinition<T>
): RegisteredJsonSettingsSection {
    return {
        ...section,
        serialize: (value) => section.serialize(value as T),
        validate: (value) => section.validate(value as T),
    };
}

export const JSON_SETTINGS_SECTIONS: readonly RegisteredJsonSettingsSection[] = [
    defineJsonSettingsSection({
        key: BROWSER_SETTINGS_KEY,
        version: BROWSER_SETTINGS_VERSION,
        stateKey: 'browserSettings',
        defaultValue: DEFAULT_BROWSER_SETTINGS,
        parse: parseBrowserSettingsConfig,
        serialize: serializeBrowserSettingsConfig,
        validate: validateBrowserSettings,
        store: {
            computedName: 'browserSettings',
            updaterName: 'updateBrowserSettings',
        },
        ui: {
            sectionId: 'browser',
            icon: 'globe',
            labelKey: 'settings.nav.browser.label',
            descriptionKey: 'settings.nav.browser.description',
            navigationOrder: 20,
        },
    }),
    defineJsonSettingsSection({
        key: SEARCH_SETTINGS_KEY,
        version: SEARCH_SETTINGS_VERSION,
        stateKey: 'searchSettings',
        defaultValue: DEFAULT_SEARCH_SETTINGS,
        parse: parseSearchSettingsConfig,
        serialize: serializeSearchSettingsConfig,
        validate: validateSearchSettings,
        store: {
            computedName: 'searchSettings',
            updaterName: 'updateSearchSettings',
        },
        ui: {
            sectionId: 'search',
            icon: 'search',
            labelKey: 'settings.nav.search.label',
            descriptionKey: 'settings.nav.search.description',
            navigationOrder: 10,
        },
    }),
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

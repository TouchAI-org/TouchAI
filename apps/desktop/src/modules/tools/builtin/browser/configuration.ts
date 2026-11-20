import { z } from '@/utils/zod';

export type BrowserPermissionMode = 'allow' | 'ask' | 'deny';
export type BrowserPermissionProfile = 'allow' | 'auto' | 'deny';
export type ExistingSessionPolicy = 'auto' | 'deny' | 'ask';
export type ScreenshotAttachmentMode = 'always' | 'ask' | 'never';
export type BrowserFingerprintMode = 'off' | 'balanced';
export type BrowserFingerprintProfile = 'off' | 'basic' | 'enhanced';

export const BROWSER_SETTINGS_VERSION = 1;

export interface BrowserDomainRule {
    domain: string;
}

export interface BrowserSettingsConfig {
    version: typeof BROWSER_SETTINGS_VERSION;
    enabled: boolean;
    headless: boolean;
    browserExecutablePath: string;
    browserDataPath: string;
    defaultHomepage: string;
    screenshotAttachmentMode: ScreenshotAttachmentMode;
    permissionMode: BrowserPermissionProfile;
    fingerprintProfile: BrowserFingerprintProfile;
    fingerprintMode: BrowserFingerprintMode;
    fingerprintLocale: string;
    fingerprintTimezone: string;
    fingerprintUserAgent: string;
    fingerprintWindowSize: string;
    fingerprintStealthScript: boolean;
    existingSessionPolicy: ExistingSessionPolicy;
    permissions: {
        navigate: BrowserPermissionMode;
        connectExisting: BrowserPermissionMode;
        observeDom: BrowserPermissionMode;
        screenshot: BrowserPermissionMode;
        click: BrowserPermissionMode;
        type: BrowserPermissionMode;
        fillForm: BrowserPermissionMode;
        history: BrowserPermissionMode;
        diagnostics: BrowserPermissionMode;
    };
    blockedDomains: BrowserDomainRule[];
    allowedDomains: BrowserDomainRule[];
}

export const BROWSER_SETTINGS_KEY = 'browser_settings';

export const DEFAULT_BROWSER_SETTINGS: BrowserSettingsConfig = {
    version: BROWSER_SETTINGS_VERSION,
    enabled: true,
    headless: false,
    browserExecutablePath: '',
    browserDataPath: '',
    defaultHomepage: 'https://touch-ai.org',
    screenshotAttachmentMode: 'ask',
    permissionMode: 'auto',
    fingerprintProfile: 'off',
    fingerprintMode: 'off',
    fingerprintLocale: 'zh-CN',
    fingerprintTimezone: 'Asia/Shanghai',
    fingerprintUserAgent: '',
    fingerprintWindowSize: '1366,768',
    fingerprintStealthScript: false,
    existingSessionPolicy: 'ask',
    permissions: {
        navigate: 'ask',
        connectExisting: 'ask',
        observeDom: 'allow',
        screenshot: 'ask',
        click: 'ask',
        type: 'ask',
        fillForm: 'ask',
        history: 'ask',
        diagnostics: 'ask',
    },
    blockedDomains: [],
    allowedDomains: [],
};

const permissionModeSchema = z.enum(['allow', 'ask', 'deny']);
const permissionProfileSchema = z.enum(['allow', 'auto', 'deny']);
const existingSessionPolicySchema = z.enum(['auto', 'deny', 'ask']);
const screenshotAttachmentModeSchema = z.enum(['always', 'ask', 'never']);
const fingerprintModeSchema = z.enum(['off', 'balanced']);
const fingerprintProfileSchema = z.enum(['off', 'basic', 'enhanced']);

const browserSettingsSchema = z
    .object({
        version: z.number().int().optional(),
        enabled: z.boolean().optional(),
        headless: z.boolean().optional(),
        browserExecutablePath: z.string().optional(),
        browserDataPath: z.string().optional(),
        defaultHomepage: z.string().optional(),
        screenshotAttachmentMode: screenshotAttachmentModeSchema.optional(),
        permissionMode: permissionProfileSchema.optional(),
        fingerprintProfile: fingerprintProfileSchema.optional(),
        fingerprintMode: fingerprintModeSchema.optional(),
        fingerprintLocale: z.string().optional(),
        fingerprintTimezone: z.string().optional(),
        fingerprintUserAgent: z.string().optional(),
        fingerprintWindowSize: z.string().optional(),
        fingerprintStealthScript: z.boolean().optional(),
        existingSessionPolicy: existingSessionPolicySchema.optional(),
        permissions: z
            .object({
                navigate: permissionModeSchema.optional(),
                connectExisting: permissionModeSchema.optional(),
                observeDom: permissionModeSchema.optional(),
                screenshot: permissionModeSchema.optional(),
                click: permissionModeSchema.optional(),
                type: permissionModeSchema.optional(),
                fillForm: permissionModeSchema.optional(),
                history: permissionModeSchema.optional(),
                diagnostics: permissionModeSchema.optional(),
            })
            .optional(),
        blockedDomains: z.array(z.object({ domain: z.string() })).optional(),
        allowedDomains: z.array(z.object({ domain: z.string() })).optional(),
    })
    .passthrough();

function cloneDefaultBrowserSettings(): BrowserSettingsConfig {
    return {
        ...DEFAULT_BROWSER_SETTINGS,
        permissions: { ...DEFAULT_BROWSER_SETTINGS.permissions },
        blockedDomains: [],
        allowedDomains: [],
    };
}

function normalizeDomainRules(value: BrowserDomainRule[] | undefined): BrowserDomainRule[] {
    if (!value) {
        return [];
    }

    const seen = new Set<string>();
    const rules: BrowserDomainRule[] = [];
    for (const rule of value) {
        const domain = rule.domain.trim().toLowerCase();
        if (!domain || seen.has(domain)) {
            continue;
        }
        seen.add(domain);
        rules.push({ domain });
    }
    return rules;
}

function fingerprintProfileFromLegacy(
    mode: BrowserFingerprintMode | undefined,
    stealthScript: boolean | undefined
): BrowserFingerprintProfile {
    if (mode !== 'balanced') {
        return 'off';
    }

    return stealthScript === false ? 'basic' : 'enhanced';
}

function fingerprintModeFromProfile(profile: BrowserFingerprintProfile): BrowserFingerprintMode {
    return profile === 'off' ? 'off' : 'balanced';
}

function fingerprintStealthScriptFromProfile(profile: BrowserFingerprintProfile): boolean {
    return profile === 'enhanced';
}

export function parseBrowserSettingsConfig(configJson: string | null): BrowserSettingsConfig {
    if (!configJson) {
        return cloneDefaultBrowserSettings();
    }

    try {
        const parsed = browserSettingsSchema.safeParse(JSON.parse(configJson));
        if (!parsed.success) {
            return cloneDefaultBrowserSettings();
        }

        const data = parsed.data;
        const fingerprintProfile =
            data.fingerprintProfile ??
            fingerprintProfileFromLegacy(data.fingerprintMode, data.fingerprintStealthScript);
        return {
            version: BROWSER_SETTINGS_VERSION,
            enabled: data.enabled ?? DEFAULT_BROWSER_SETTINGS.enabled,
            headless: data.headless ?? DEFAULT_BROWSER_SETTINGS.headless,
            browserExecutablePath: data.browserExecutablePath?.trim() ?? '',
            browserDataPath: data.browserDataPath?.trim() ?? '',
            defaultHomepage:
                data.defaultHomepage?.trim() ?? DEFAULT_BROWSER_SETTINGS.defaultHomepage,
            screenshotAttachmentMode:
                data.screenshotAttachmentMode ?? DEFAULT_BROWSER_SETTINGS.screenshotAttachmentMode,
            permissionMode: data.permissionMode ?? DEFAULT_BROWSER_SETTINGS.permissionMode,
            fingerprintProfile,
            fingerprintMode: fingerprintModeFromProfile(fingerprintProfile),
            fingerprintLocale:
                data.fingerprintLocale?.trim() || DEFAULT_BROWSER_SETTINGS.fingerprintLocale,
            fingerprintTimezone:
                data.fingerprintTimezone?.trim() || DEFAULT_BROWSER_SETTINGS.fingerprintTimezone,
            fingerprintUserAgent: data.fingerprintUserAgent?.trim() ?? '',
            fingerprintWindowSize:
                normalizeFingerprintWindowSize(data.fingerprintWindowSize) ??
                DEFAULT_BROWSER_SETTINGS.fingerprintWindowSize,
            fingerprintStealthScript: fingerprintStealthScriptFromProfile(fingerprintProfile),
            existingSessionPolicy:
                data.existingSessionPolicy ?? DEFAULT_BROWSER_SETTINGS.existingSessionPolicy,
            permissions: {
                ...DEFAULT_BROWSER_SETTINGS.permissions,
                ...(data.permissions ?? {}),
            },
            blockedDomains: normalizeDomainRules(data.blockedDomains),
            allowedDomains: normalizeDomainRules(data.allowedDomains),
        };
    } catch {
        return cloneDefaultBrowserSettings();
    }
}

export function serializeBrowserSettingsConfig(config: BrowserSettingsConfig): string {
    const fingerprintProfile =
        config.fingerprintProfile ??
        fingerprintProfileFromLegacy(config.fingerprintMode, config.fingerprintStealthScript);
    const normalized: BrowserSettingsConfig = {
        version: BROWSER_SETTINGS_VERSION,
        enabled: config.enabled,
        headless: config.headless,
        browserExecutablePath: config.browserExecutablePath.trim(),
        browserDataPath: config.browserDataPath.trim(),
        defaultHomepage: config.defaultHomepage.trim(),
        screenshotAttachmentMode: config.screenshotAttachmentMode,
        permissionMode: config.permissionMode ?? DEFAULT_BROWSER_SETTINGS.permissionMode,
        fingerprintProfile,
        fingerprintMode: fingerprintModeFromProfile(fingerprintProfile),
        fingerprintLocale:
            config.fingerprintLocale.trim() || DEFAULT_BROWSER_SETTINGS.fingerprintLocale,
        fingerprintTimezone:
            config.fingerprintTimezone.trim() || DEFAULT_BROWSER_SETTINGS.fingerprintTimezone,
        fingerprintUserAgent: config.fingerprintUserAgent.trim(),
        fingerprintWindowSize:
            normalizeFingerprintWindowSize(config.fingerprintWindowSize) ??
            DEFAULT_BROWSER_SETTINGS.fingerprintWindowSize,
        fingerprintStealthScript: fingerprintStealthScriptFromProfile(fingerprintProfile),
        existingSessionPolicy: config.existingSessionPolicy,
        permissions: {
            ...DEFAULT_BROWSER_SETTINGS.permissions,
            ...config.permissions,
        },
        blockedDomains: normalizeDomainRules(config.blockedDomains),
        allowedDomains: normalizeDomainRules(config.allowedDomains),
    };

    return JSON.stringify(normalized);
}

export function normalizeFingerprintWindowSize(value: string | undefined): string | null {
    const match = value?.trim().match(/^(\d{3,5})\s*[,xX]\s*(\d{3,5})$/);
    if (!match) return null;
    const width = Number(match[1]);
    const height = Number(match[2]);
    if (width < 800 || width > 3840 || height < 600 || height > 2160) return null;
    return `${width},${height}`;
}

type BrowserSettingsValidationMessageKey = 'settings.browser.validation.invalidHomepage';

export function getDefaultHomepageError(
    config: BrowserSettingsConfig
): BrowserSettingsValidationMessageKey | null {
    const value = config.defaultHomepage.trim();
    if (!value) {
        return null;
    }

    try {
        const url = new URL(value);
        return url.protocol === 'http:' || url.protocol === 'https:'
            ? null
            : 'settings.browser.validation.invalidHomepage';
    } catch {
        return 'settings.browser.validation.invalidHomepage';
    }
}

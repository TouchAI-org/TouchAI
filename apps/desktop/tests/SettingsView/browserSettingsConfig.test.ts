import { createPinia, setActivePinia } from 'pinia';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const settingsValues = new Map<string, string | null>();
const setSettingMock = vi.hoisted(() =>
    vi.fn(async ({ key, value }: { key: string; value: string }) => {
        settingsValues.set(key, value);
        return { id: 1, key, value, created_at: '', updated_at: '' };
    })
);
const getSettingValueMock = vi.hoisted(() =>
    vi.fn(async ({ key }: { key: string }) => settingsValues.get(key) ?? null)
);

vi.mock('@database/queries', () => ({
    getSettingValue: getSettingValueMock,
    setSetting: setSettingMock,
}));

vi.mock('@services/EventService', () => ({
    AppEvent: { SETTINGS_GENERAL_UPDATED: 'settings-general-updated' },
    eventService: {
        emit: vi.fn(async () => undefined),
        on: vi.fn(async () => undefined),
    },
}));

vi.mock('@tauri-apps/api/window', () => ({
    getCurrentWindow: () => ({ label: 'settings' }),
}));

describe('browser settings config', () => {
    beforeEach(() => {
        settingsValues.clear();
        setSettingMock.mockClear();
        getSettingValueMock.mockClear();
        setActivePinia(createPinia());
    });

    it('normalizes defaults and invalid json', async () => {
        const {
            DEFAULT_BROWSER_SETTINGS,
            getDefaultHomepageError,
            parseBrowserSettingsConfig,
            serializeBrowserSettingsConfig,
        } = await import('@/stores/setting/sections/browser');

        expect(DEFAULT_BROWSER_SETTINGS.version).toBe(1);
        expect(DEFAULT_BROWSER_SETTINGS.defaultHomepage).toBe('https://touch-ai.org');
        expect(DEFAULT_BROWSER_SETTINGS.headless).toBe(false);
        expect(DEFAULT_BROWSER_SETTINGS.existingSessionPolicy).toBe('ask');
        expect(DEFAULT_BROWSER_SETTINGS.permissionMode).toBe('auto');
        expect(DEFAULT_BROWSER_SETTINGS.fingerprintProfile).toBe('off');
        expect(DEFAULT_BROWSER_SETTINGS.fingerprintMode).toBe('off');
        expect(parseBrowserSettingsConfig('{bad json')).toEqual(DEFAULT_BROWSER_SETTINGS);
        expect(
            getDefaultHomepageError({
                ...DEFAULT_BROWSER_SETTINGS,
                defaultHomepage: 'ftp://example.test',
            })
        ).toBe('settings.browser.validation.invalidHomepage');
        expect(serializeBrowserSettingsConfig(parseBrowserSettingsConfig(null))).toBe(
            serializeBrowserSettingsConfig(DEFAULT_BROWSER_SETTINGS)
        );
        expect(parseBrowserSettingsConfig('{}').defaultHomepage).toBe('https://touch-ai.org');
        expect(parseBrowserSettingsConfig('{}').version).toBe(1);
        expect(JSON.parse(serializeBrowserSettingsConfig(DEFAULT_BROWSER_SETTINGS))).toMatchObject({
            version: 1,
        });
        expect(
            parseBrowserSettingsConfig(JSON.stringify({ defaultHomepage: '' })).defaultHomepage
        ).toBe('');
    });

    it('trims string fields and preserves configured permissions', async () => {
        const { parseBrowserSettingsConfig } = await import('@/stores/setting/sections/browser');

        expect(
            parseBrowserSettingsConfig(
                JSON.stringify({
                    browserExecutablePath: '  C:/Program Files/Browser/browser.exe  ',
                    browserDataPath: '  D:/TouchAI/BrowserData  ',
                    defaultHomepage: '  https://example.test/start  ',
                    headless: true,
                    existingSessionPolicy: 'auto',
                    permissionMode: 'allow',
                    screenshotAttachmentMode: 'always',
                    fingerprintProfile: 'basic',
                    fingerprintMode: 'balanced',
                    fingerprintLocale: '  zh-CN  ',
                    fingerprintTimezone: '  Asia/Shanghai  ',
                    fingerprintUserAgent: '  Mozilla/5.0 TouchAI-compatible  ',
                    fingerprintWindowSize: '  1440x900  ',
                    fingerprintStealthScript: false,
                    permissions: {
                        navigate: 'allow',
                        screenshot: 'deny',
                    },
                    blockedDomains: [{ domain: '  blocked.example  ' }],
                    allowedDomains: [{ domain: '  allowed.example  ' }],
                })
            )
        ).toMatchObject({
            browserExecutablePath: 'C:/Program Files/Browser/browser.exe',
            browserDataPath: 'D:/TouchAI/BrowserData',
            defaultHomepage: 'https://example.test/start',
            headless: true,
            existingSessionPolicy: 'auto',
            permissionMode: 'allow',
            screenshotAttachmentMode: 'always',
            fingerprintProfile: 'basic',
            fingerprintMode: 'balanced',
            fingerprintLocale: 'zh-CN',
            fingerprintTimezone: 'Asia/Shanghai',
            fingerprintUserAgent: 'Mozilla/5.0 TouchAI-compatible',
            fingerprintWindowSize: '1440,900',
            fingerprintStealthScript: false,
            permissions: {
                navigate: 'allow',
                screenshot: 'deny',
                click: 'ask',
            },
            blockedDomains: [{ domain: 'blocked.example' }],
            allowedDomains: [{ domain: 'allowed.example' }],
        });
    });

    it('derives the merged fingerprint profile from legacy fingerprint fields', async () => {
        const { parseBrowserSettingsConfig } = await import('@/stores/setting/sections/browser');

        expect(
            parseBrowserSettingsConfig(
                JSON.stringify({
                    fingerprintMode: 'balanced',
                    fingerprintStealthScript: true,
                })
            )
        ).toMatchObject({
            fingerprintProfile: 'enhanced',
            fingerprintMode: 'balanced',
            fingerprintStealthScript: true,
        });

        expect(
            parseBrowserSettingsConfig(
                JSON.stringify({
                    fingerprintMode: 'balanced',
                    fingerprintStealthScript: false,
                })
            )
        ).toMatchObject({
            fingerprintProfile: 'basic',
            fingerprintMode: 'balanced',
            fingerprintStealthScript: false,
        });
    });

    it('loads and saves browser settings through the existing settings store', async () => {
        const { DEFAULT_BROWSER_SETTINGS } = await import('@/stores/setting/sections/browser');
        const { useSettingsStore } = await import('@/stores/settings');
        settingsValues.set(
            'browser_settings',
            JSON.stringify({
                defaultHomepage: 'https://example.test/home',
                existingSessionPolicy: 'deny',
            })
        );

        const store = useSettingsStore();
        await store.initialize();

        expect(store.settings.browserSettings).toMatchObject({
            ...DEFAULT_BROWSER_SETTINGS,
            defaultHomepage: 'https://example.test/home',
            existingSessionPolicy: 'deny',
        });

        await store.updateBrowserSettings({
            ...store.settings.browserSettings,
            defaultHomepage: 'https://example.test/next',
            headless: true,
        });

        expect(setSettingMock).toHaveBeenLastCalledWith({
            key: 'browser_settings',
            value: expect.stringContaining('https://example.test/next'),
        });
        expect(setSettingMock).toHaveBeenLastCalledWith({
            key: 'browser_settings',
            value: expect.stringContaining('"headless":true'),
        });
    });
});
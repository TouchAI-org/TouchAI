import { closeTestDatabases } from '@tests/database/sqliteHarness';
import { createSettingsWindowFixture } from '@tests/utils/settingsWindow';
import { afterEach, describe, expect, it } from 'vitest';
afterEach(closeTestDatabases);

describe('user edits the browser settings', () => {
    it('user normalizes defaults and invalid json', async () => {
        const {
            DEFAULT_BROWSER_SETTINGS,
            getDefaultHomepageError,
            parseBrowserSettingsConfig,
            serializeBrowserSettingsConfig,
        } = await import('@/app/api/settings/tools');

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

    it('user trims string fields and preserves configured permissions', async () => {
        const { parseBrowserSettingsConfig } = await import('@/app/api/settings/tools');

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

    it('user derives the merged fingerprint profile from legacy fingerprint fields', async () => {
        const { parseBrowserSettingsConfig } = await import('@/app/api/settings/tools');

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

    it('user loads saved browser configuration and commits edits through the main writer', async () => {
        const fixture = createSettingsWindowFixture({
            label: 'settings',
            values: {
                browser_settings: JSON.stringify({
                    defaultHomepage: 'https://example.test/home',
                    existingSessionPolicy: 'deny',
                }),
            },
        });
        try {
            await fixture.initialize();
            const store = fixture.tools();
            await store.initialize();
            expect(store.browserSettings).toMatchObject({
                defaultHomepage: 'https://example.test/home',
                existingSessionPolicy: 'deny',
            });
            await store.updateBrowserSettings({
                ...store.browserSettings,
                defaultHomepage: 'https://example.test/next',
                headless: true,
            });
            expect(JSON.parse(fixture.values.get('browser_settings')!)).toMatchObject({
                defaultHomepage: 'https://example.test/next',
                headless: true,
            });
        } finally {
            fixture.dispose();
        }
    });
});

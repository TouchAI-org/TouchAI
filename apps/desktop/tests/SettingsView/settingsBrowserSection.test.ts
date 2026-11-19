import {
    chooseSettingsOption,
    createSettingsPanelFixture,
    openSettingsSelect,
} from '@tests/utils/settingsPanel';
import { getTauriInvokeCalls, mockTauriCommand } from '@tests/utils/tauri';
import { flushPromises, mount, type VueWrapper } from '@vue/test-utils';
import { createPinia, disposePinia } from 'pinia';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import {
    type BrowserSettingsConfig,
    DEFAULT_BROWSER_SETTINGS,
    parseBrowserSettingsConfig,
} from '@/app/api/settings/tools';
import { setLocale } from '@/i18n';
import BrowserSettingsView from '@/views/SettingsView/components/Browser/index.vue';
import { searchSettings } from '@/views/SettingsView/settingsSearch';

const chrome = {
    id: 'chrome',
    name: 'Google Chrome',
    path: 'C:/Program Files/Google/Chrome/Application/chrome.exe',
};
const edge = {
    id: 'edge',
    name: 'Microsoft Edge',
    path: 'C:/Program Files/Microsoft/Edge/Application/msedge.exe',
};
const defaultDataPath = 'C:/Users/test/AppData/Roaming/TouchAI/browser-data';
let fixture: Awaited<ReturnType<typeof createSettingsPanelFixture>> | undefined;
let wrapper: VueWrapper | undefined;
let pauseWrite: (() => Promise<void>) | undefined;

beforeEach(() => {
    vi.useFakeTimers();
    setLocale('en-US');
    pauseWrite = undefined;
    vi.stubGlobal(
        'ResizeObserver',
        class {
            observe() {}
            unobserve() {}
            disconnect() {}
        }
    );
    mockTauriCommand('browser_discover_installed', [chrome, edge]);
    mockTauriCommand('browser_default_data_path', defaultDataPath);
});

afterEach(async () => {
    wrapper?.unmount();
    wrapper = undefined;
    await fixture?.dispose();
    fixture = undefined;
    vi.useRealTimers();
    vi.unstubAllGlobals();
    document.body.innerHTML = '';
});

async function openPanel(patch: Partial<BrowserSettingsConfig> = {}, language = 'en-US') {
    fixture = await createSettingsPanelFixture({
        values: {
            language,
            browser_settings: JSON.stringify({
                ...DEFAULT_BROWSER_SETTINGS,
                defaultHomepage: 'https://example.test/home',
                browserExecutablePath: chrome.path,
                browserDataPath: 'D:/TouchAI/BrowserData',
                ...patch,
            }),
        },
        query: {
            async beforeQuery({ sql, params }) {
                if (sql.startsWith('insert') && params[0] === 'browser_settings')
                    await pauseWrite?.();
            },
        },
    });
    wrapper = mount(BrowserSettingsView, fixture.viewOptions);
    await flushPromises();
    return wrapper;
}
const persisted = () => fixture!.saved('browser_settings');
const saved = () => parseBrowserSettingsConfig(persisted() ?? null);
async function settleSave() {
    await vi.advanceTimersByTimeAsync(300);
    await flushPromises();
}

function select(panel: VueWrapper, target: string) {
    return panel.get(`[data-settings-search-target="browser-${target}"] [role="combobox"]`);
}

describe('given browser configuration is edited through production main and a settings client', () => {
    it('user sees browser controls and autosaves a mode and homepage through the main writer', async () => {
        const panel = await openPanel();
        expect(panel.get('[data-testid="browser-settings-title"]').text()).toContain(
            'Browser Control'
        );
        expect(panel.text()).toContain('Manage how TouchAI controls browser behavior.');
        expect(panel.get('[data-testid="browser-data-path-input"]').element).toMatchObject({
            value: 'D:/TouchAI/BrowserData',
        });
        expect(panel.get('[data-testid="browser-data-path-input"]').attributes('placeholder')).toBe(
            'browser-data'
        );
        expect(select(panel, 'executable').text()).toContain('Google Chrome');
        expect(panel.find('[data-testid="browser-executable-path-input"]').exists()).toBe(false);
        expect(panel.get('[data-testid="browser-default-homepage-input"]').element).toMatchObject({
            value: 'https://example.test/home',
        });
        expect(
            panel.get('[data-testid="browser-default-homepage-input"]').attributes('placeholder')
        ).toBe('https://touch-ai.org');
        expect(panel.find('[data-testid="browser-save-button"]').exists()).toBe(false);
        expect(panel.text()).toContain('Permissions');
        expect(panel.text()).toContain('Allowlist domains');
        expect(panel.text()).toContain('Blocklist domains');
        expect(panel.text()).toContain('Advanced');
        expect(panel.get('[data-testid="browser-fingerprint-profile-row"]').classes()).toContain(
            'sm:grid-cols-[minmax(0,1fr)_320px]'
        );
        await chooseSettingsOption(select(panel, 'mode'), 'Headless mode');
        await settleSave();
        expect(saved().headless).toBe(true);
        await panel
            .get('[data-testid="browser-default-homepage-input"]')
            .setValue('https://example.test/next');
        await settleSave();
        expect(saved()).toMatchObject({
            headless: true,
            defaultHomepage: 'https://example.test/next',
        });
        expect(JSON.stringify(fixture!.client.settings.getSnapshot())).not.toContain(
            'browserSettings'
        );
    });

    it('user edits separate window dimensions and main retains the existing serialized pair', async () => {
        const panel = await openPanel();
        expect(panel.get('[data-testid="browser-window-width-input"]').element).toMatchObject({
            value: '1366',
        });
        expect(panel.get('[data-testid="browser-window-height-input"]').element).toMatchObject({
            value: '768',
        });
        await panel.get('[data-testid="browser-window-width-input"]').setValue('1440');
        await panel.get('[data-testid="browser-window-height-input"]').setValue('900');
        await settleSave();
        expect(saved().fingerprintWindowSize).toBe('1440,900');
    });

    it('user keeps a pending homepage while incorporating another window mode change', async () => {
        const panel = await openPanel();
        await panel
            .get('[data-testid="browser-default-homepage-input"]')
            .setValue('https://example.test/pending');
        const incoming = fixture!.window.toolSettings!.getBrowserSettings();
        await fixture!.window.toolSettings!.updateBrowserSettings({
            ...incoming,
            defaultHomepage: 'https://example.test/other-window',
            headless: true,
        });
        await flushPromises();
        await settleSave();
        expect(saved()).toMatchObject({
            defaultHomepage: 'https://example.test/pending',
            headless: true,
        });
    });

    it('user navigates translated browser search results to their matching controls', async () => {
        const panel = await openPanel({}, 'zh-CN');
        const sizeResult = searchSettings('窗口尺寸').find(
            (result) => result.section === 'browser'
        );
        expect(sizeResult?.targetId).toBe('browser-window-size');
        const sizeRow = panel.get(`[data-settings-search-target="${sizeResult!.targetId}"]`);
        expect(sizeRow.find('[data-testid="browser-window-width-input"]').exists()).toBe(true);
        expect(sizeRow.find('[data-testid="browser-window-height-input"]').exists()).toBe(true);
        const agentResult = searchSettings('User-Agent').find(
            (result) => result.section === 'browser'
        );
        expect(agentResult?.targetId).toBe('browser-user-agent');
        expect(
            panel
                .get(`[data-settings-search-target="${agentResult!.targetId}"] input`)
                .attributes('placeholder')
        ).toBe('Mozilla/5.0 ...');
    });

    it('user receives localized homepage validation and an invalid URL is never persisted', async () => {
        const panel = await openPanel({}, 'zh-CN');
        const original = persisted();
        await panel
            .get('[data-testid="browser-default-homepage-input"]')
            .setValue('ftp://example.test');
        await settleSave();
        expect(panel.text()).toContain('请输入有效的 http 或 https 地址');
        expect(panel.text()).not.toContain('settings.browser.validation.invalidHomepage');
        expect(persisted()).toBe(original);
        await panel
            .get('[data-testid="browser-default-homepage-input"]')
            .setValue('https://example.test/recovered');
        await settleSave();
        expect(saved().defaultHomepage).toBe('https://example.test/recovered');
    });

    it('user sees detailed permissions only in automatic mode and saves the chosen profile', async () => {
        const panel = await openPanel();
        expect(
            panel.find('[data-settings-search-target="browser-permission-navigate"]').exists()
        ).toBe(true);
        expect(
            panel
                .find('[data-settings-search-target="browser-permission-connectExisting"]')
                .exists()
        ).toBe(true);
        await chooseSettingsOption(select(panel, 'permission-mode'), 'Always allow');
        await settleSave();
        expect(saved().permissionMode).toBe('allow');
        expect(
            panel.find('[data-settings-search-target="browser-permission-navigate"]').exists()
        ).toBe(false);
        expect(
            panel
                .find('[data-settings-search-target="browser-permission-connectExisting"]')
                .exists()
        ).toBe(false);
    });

    it('user disables browser controls and that choice is committed by main', async () => {
        const panel = await openPanel();
        await panel.get('[data-testid="browser-enabled-toggle"]').trigger('click');
        expect(
            panel.get('[data-testid="browser-data-path-input"]').attributes('disabled')
        ).toBeDefined();
        expect(select(panel, 'executable').attributes('disabled')).toBeDefined();
        expect(
            panel.get('[data-testid="browser-default-homepage-input"]').attributes('disabled')
        ).toBeDefined();
        expect(select(panel, 'mode').attributes('disabled')).toBeDefined();
        await settleSave();
        expect(saved().enabled).toBe(false);
    });

    it.each(['blocked', 'allowed'] as const)(
        'user closes a blank %s domain draft on blur without changing saved rules',
        async (kind) => {
            const panel = await openPanel();
            const original = persisted();
            const section = panel.get(`[data-settings-search-target="browser-${kind}-domains"]`);
            await section.get('[data-testid="empty-state"] button').trigger('click');
            expect(section.find('[data-testid="empty-state"]').exists()).toBe(false);
            expect(section.get('button[aria-label="Cancel"]').text()).toBe('');
            await section.get('input').setValue('   ');
            await section.get('input').trigger('blur');
            expect(section.find('input').exists()).toBe(false);
            expect(section.find('[data-testid="empty-state"]').exists()).toBe(true);
            await settleSave();
            expect(persisted()).toBe(original);
        }
    );

    it.each(['blocked', 'allowed'] as const)(
        'user keeps an unsubmitted %s domain on blur until cancelling the draft',
        async (kind) => {
            const panel = await openPanel();
            const original = persisted();
            const section = panel.get(`[data-settings-search-target="browser-${kind}-domains"]`);
            await section.get('button').trigger('click');
            await section.get('input').setValue('example.com');
            await section.get('input').trigger('blur');
            expect(section.get('input').element).toMatchObject({ value: 'example.com' });
            expect(section.find('[data-testid="empty-state"]').exists()).toBe(false);
            await section.get('button[aria-label="Cancel"]').trigger('click');
            expect(section.find('input').exists()).toBe(false);
            expect(section.find('[data-testid="empty-state"]').exists()).toBe(true);
            await section.get('button').trigger('click');
            expect(section.get('input').element).toMatchObject({ value: '' });
            await settleSave();
            expect(persisted()).toBe(original);
        }
    );

    it.each(['blocked', 'allowed'] as const)(
        'user saves a normalized %s domain on Enter and can remove the committed rule',
        async (kind) => {
            const panel = await openPanel();
            const section = panel.get(`[data-settings-search-target="browser-${kind}-domains"]`);
            await section.get('button').trigger('click');
            await section.get('input').setValue(' EXAMPLE.com ');
            await section.get('input').trigger('keydown', { key: 'Enter' });
            await settleSave();
            expect(section.find('button[aria-label="Cancel"]').exists()).toBe(false);
            expect(section.get('input[readonly]').element).toMatchObject({ value: 'example.com' });
            expect(saved()[`${kind}Domains`]).toEqual([{ domain: 'example.com' }]);
            await section.findAll('button')[1]!.trigger('click');
            await settleSave();
            expect(saved()[`${kind}Domains`]).toEqual([]);
        }
    );

    it('user sees Chinese browser copy and its localized permission choices', async () => {
        const panel = await openPanel({}, 'zh-CN');
        expect(panel.get('[data-testid="browser-settings-title"]').text()).toContain('浏览器控制');
        expect(panel.text()).toContain('管理 TouchAI 控制浏览器的行为。');
        expect(panel.text()).toContain('白名单域名');
        expect(panel.text()).toContain('黑名单域名');
        expect(panel.text()).toContain('高级');
        expect(panel.text()).toContain('指纹模拟');
        expect(panel.text()).not.toContain('Browser Control');
        const options = await openSettingsSelect(select(panel, 'permission-mode'));
        expect(options.map((option) => option.text())).toEqual(['始终允许', '自动', '拒绝']);
    });

    it('user sees runtime defaults without materializing them into saved configuration', async () => {
        const panel = await openPanel({
            browserExecutablePath: '',
            browserDataPath: '',
            defaultHomepage: '',
        });
        const original = persisted();
        expect(select(panel, 'executable').text()).toContain('Default browser');
        expect(panel.get('[data-testid="browser-data-path-input"]').element).toMatchObject({
            value: defaultDataPath,
        });
        expect(panel.get('[data-testid="browser-default-homepage-input"]').element).toMatchObject({
            value: 'https://touch-ai.org',
        });
        const options = await openSettingsSelect(select(panel, 'executable'));
        expect(options.map((option) => option.text())).toEqual(
            expect.arrayContaining([
                expect.stringContaining('Currently uses Google Chrome'),
                expect.stringContaining(edge.path),
                'Custom browser location',
            ])
        );
        expect(options[0]!.text()).not.toContain(chrome.path);
        expect(panel.find('[data-testid="browser-executable-path-input"]').exists()).toBe(false);
        await settleSave();
        expect(persisted()).toBe(original);
    });

    it('user remounts a panel in the same window and retains its cached browser catalog', async () => {
        const first = await openPanel();
        expect(select(first, 'executable').text()).toContain('Google Chrome');
        first.unmount();
        mockTauriCommand('browser_discover_installed', [edge]);
        wrapper = mount(BrowserSettingsView, fixture!.viewOptions);
        await flushPromises();
        expect(select(wrapper, 'executable').text()).toContain('Google Chrome');
        expect(getTauriInvokeCalls('browser_discover_installed')).toHaveLength(1);
    });

    it('user reopens the app projection and receives a fresh catalog rather than another window cache', async () => {
        const first = await openPanel();
        first.unmount();
        disposePinia(fixture!.pinia);
        mockTauriCommand('browser_discover_installed', [edge]);
        const pinia = createPinia();
        try {
            wrapper = mount(BrowserSettingsView, {
                ...fixture!.viewOptions,
                global: { ...fixture!.viewOptions.global, plugins: [pinia] },
            });
            await flushPromises();
            expect(wrapper.find('[data-testid="browser-executable-path-input"]').exists()).toBe(
                true
            );
            const options = await openSettingsSelect(select(wrapper, 'executable'));
            expect(
                options
                    .map((option) => option.text())
                    .some((text) => text.includes('Microsoft Edge'))
            ).toBe(true);
            expect(
                options.map((option) => option.text()).some((text) => text.includes(chrome.path))
            ).toBe(false);
        } finally {
            wrapper?.unmount();
            wrapper = undefined;
            disposePinia(pinia);
        }
    });

    it('user opens the browser selector and sees newly discovered executables without a blocking reload', async () => {
        const panel = await openPanel();
        const firefox = { id: 'firefox', name: 'Firefox', path: 'D:/Browsers/Firefox/firefox.exe' };
        mockTauriCommand('browser_discover_installed', [chrome, firefox]);
        const options = await openSettingsSelect(select(panel, 'executable'));
        expect(options.map((option) => option.text())).toEqual(
            expect.arrayContaining([expect.stringContaining(firefox.path)])
        );
        expect(getTauriInvokeCalls('browser_discover_installed')).toHaveLength(2);
    });

    it('user sees the existing-session policy and main saves a change to denial', async () => {
        const panel = await openPanel({ existingSessionPolicy: 'ask' });
        expect(select(panel, 'existing-session').text()).toContain('Ask');
        await chooseSettingsOption(select(panel, 'existing-session'), 'Deny');
        await settleSave();
        expect(saved().existingSessionPolicy).toBe('deny');
    });

    it('user switches to a custom path without writing a discovered default and then saves the entered path', async () => {
        const panel = await openPanel({ browserExecutablePath: '' });
        const original = persisted();
        await chooseSettingsOption(select(panel, 'executable'), 'Custom browser location');
        expect(panel.get('[data-testid="browser-executable-path-input"]').element).toMatchObject({
            value: '',
        });
        await settleSave();
        expect(persisted()).toBe(original);
        await panel
            .get('[data-testid="browser-executable-path-input"]')
            .setValue('D:/Browsers/Chrome/chrome.exe');
        await settleSave();
        expect(saved().browserExecutablePath).toBe('D:/Browsers/Chrome/chrome.exe');
    });

    it('user chooses a discovered executable and main saves that exact path', async () => {
        const panel = await openPanel({ browserExecutablePath: '' });
        await chooseSettingsOption(select(panel, 'executable'), 'Microsoft Edge');
        await settleSave();
        expect(panel.find('[data-testid="browser-executable-path-input"]').exists()).toBe(false);
        expect(saved().browserExecutablePath).toBe(edge.path);
    });

    it('user returns to the default browser and main clears the saved custom override', async () => {
        const panel = await openPanel({ browserExecutablePath: 'D:/Custom/chrome.exe' });
        expect(panel.find('[data-testid="browser-executable-path-input"]').exists()).toBe(true);
        await chooseSettingsOption(select(panel, 'executable'), 'Default browser');
        await settleSave();
        expect(panel.find('[data-testid="browser-executable-path-input"]').exists()).toBe(false);
        expect(saved().browserExecutablePath).toBe('');
    });

    it('user closes during a save and a later browser draft is not submitted by the detached panel', async () => {
        const panel = await openPanel();
        let entered!: () => void;
        let release!: () => void;
        const writing = new Promise<void>((resolve) => {
            entered = resolve;
        });
        const barrier = new Promise<void>((resolve) => {
            release = resolve;
        });
        pauseWrite = async () => {
            entered();
            await barrier;
        };
        await panel
            .get('[data-testid="browser-default-homepage-input"]')
            .setValue('https://example.test/authorized');
        await vi.advanceTimersByTimeAsync(300);
        await writing;
        await panel
            .get('[data-testid="browser-default-homepage-input"]')
            .setValue('https://example.test/detached');
        panel.unmount();
        wrapper = undefined;
        pauseWrite = undefined;
        release();
        await flushPromises();
        await settleSave();
        expect(saved().defaultHomepage).toBe('https://example.test/authorized');
    });
});

import { chooseSettingsOption, createSettingsPanelFixture } from '@tests/utils/settingsPanel';
import { createTestWindowPresentation } from '@tests/utils/windowPresentation';
import { flushPromises, mount } from '@vue/test-utils';
import { beforeEach as beforePresentation } from 'vitest';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

// Copyright (c) 2026. Qian Cheng. Licensed under GPL v3.
import type { McpServerEntity } from '@/app/api/tools/mcpAdministration';
import { setLocale, t } from '@/i18n';
import McpServerConfig from '@/views/SettingsView/components/McpTools/components/McpServerConfig.vue';

let fixture: Awaited<ReturnType<typeof createSettingsPanelFixture>>;
const wrappers: ReturnType<typeof mount>[] = [];
afterEach(async () => {
    wrappers.splice(0).forEach((wrapper) => wrapper.unmount());
    await fixture?.dispose();
    vi.useRealTimers();
});
function savedServer() {
    return fixture.database
        .prepare('SELECT * FROM mcp_servers ORDER BY id DESC LIMIT 1')
        .get() as Record<string, unknown>;
}

function server(overrides: Partial<McpServerEntity> = {}): McpServerEntity {
    return {
        id: 5,
        name: 'filesystem',
        transport_type: 'stdio',
        command: 'npx',
        args: JSON.stringify(['-y', '@modelcontextprotocol/server-filesystem']),
        env: JSON.stringify({ HOME: '/home/me' }),
        cwd: '/work',
        url: null,
        headers: null,
        enabled: 1,
        tool_timeout: 30_000,
        version: null,
        last_error: null,
        last_connected_at: null,
        created_at: '',
        updated_at: '',
        ...overrides,
    } as McpServerEntity;
}

function newServer(overrides: Partial<McpServerEntity> = {}): McpServerEntity {
    return server({
        id: -1,
        name: '',
        command: '',
        args: null,
        env: null,
        cwd: null,
        tool_timeout: 30_000,
        ...overrides,
    });
}

function mountConfig(value: McpServerEntity) {
    if (value.id !== -1) {
        const keys = Object.keys(value);
        fixture.database
            .prepare(
                `INSERT INTO mcp_servers (${keys.join(',')}) VALUES (${keys.map(() => '?').join(',')})`
            )
            .run(...Object.values(value));
    }
    const wrapper = mount(McpServerConfig, { props: { server: value }, ...fixture.viewOptions });
    wrappers.push(wrapper);
    return wrapper;
}

function nameField(wrapper: ReturnType<typeof mountConfig>) {
    return wrapper.get('input[type="text"]');
}

/** The command field of a stdio server; its placeholder is translated. */
function commandField(wrapper: ReturnType<typeof mountConfig>): string {
    const field = wrapper
        .findAll('input[type="text"]')
        .find(
            (input) =>
                input.attributes('placeholder') === t('settings.mcp.config.commandPlaceholder')
        );
    return (field?.element as HTMLInputElement | undefined)?.value ?? '';
}

function commandInput(wrapper: ReturnType<typeof mountConfig>) {
    return wrapper
        .findAll('input[type="text"]')
        .find(
            (input) =>
                input.attributes('placeholder') === t('settings.mcp.config.commandPlaceholder')
        )!;
}

beforeEach(async () => {
    vi.clearAllMocks();
    fixture = await createSettingsPanelFixture();
    setLocale('zh-CN');
});

describe('user configures an MCP server', () => {
    it('user sees the saved connection details filled in', () => {
        const wrapper = mountConfig(server());

        expect((nameField(wrapper).element as HTMLInputElement).value).toBe('filesystem');
        expect(commandField(wrapper)).toBe('npx');
        expect((wrapper.get('input[placeholder="30000"]').element as HTMLInputElement).value).toBe(
            '30000'
        );
    });

    it('user saves a rename when leaving the name field', async () => {
        const wrapper = mountConfig(server());

        await nameField(wrapper).setValue('my filesystem');
        await nameField(wrapper).trigger('blur');
        await flushPromises();

        expect(savedServer()).toMatchObject({
            name: 'my filesystem',
            transport_type: 'stdio',
            command: 'npx',
        });
        expect(wrapper.emitted('updated')).toEqual([[false]]);
    });

    it('user saves the argument list as the server configuration expects', async () => {
        const wrapper = mountConfig(server());

        await nameField(wrapper).trigger('blur');
        await flushPromises();

        const payload = savedServer();
        expect(JSON.parse(payload.args as string)).toEqual([
            '-y',
            '@modelcontextprotocol/server-filesystem',
        ]);
        expect(JSON.parse(payload.env as string)).toEqual({ HOME: '/home/me' });
    });

    it('user sees an error and nothing is saved when the name is blank', async () => {
        const wrapper = mountConfig(server({ name: '' }));

        await nameField(wrapper).trigger('blur');
        await flushPromises();

        expect(wrapper.emitted('showAlert')).toBeTruthy();
        expect(wrapper.emitted('showAlert')![0]![1]).toBe('error');
        expect(wrapper.emitted('updated')).toBeUndefined();
    });

    it('user sees an error when a command-based server has no command', async () => {
        const wrapper = mountConfig(server({ command: '   ' }));

        await nameField(wrapper).trigger('blur');
        await flushPromises();

        expect(wrapper.emitted('updated')).toBeUndefined();
        expect(wrapper.emitted('showAlert')![0]![1]).toBe('error');
    });

    it('user switches to an HTTP server and is asked for a URL instead of a command', async () => {
        const wrapper = mountConfig(server());

        await chooseSettingsOption(wrapper.get('[role=combobox]'), 'HTTP');
        await flushPromises();

        expect(wrapper.find('input[placeholder="30000"]').exists()).toBe(true);
        expect(wrapper.text()).toContain('URL');
        expect(wrapper.text()).not.toContain('npx');
    });

    it('user sees an error when an HTTP server has no URL', async () => {
        const wrapper = mountConfig(server({ transport_type: 'http', url: '' }));

        await nameField(wrapper).trigger('blur');
        await flushPromises();

        expect(wrapper.emitted('updated')).toBeUndefined();
        expect(wrapper.emitted('showAlert')![0]![1]).toBe('error');
    });

    it('user saves an HTTP server with its URL and headers', async () => {
        const wrapper = mountConfig(
            server({
                transport_type: 'http',
                command: null,
                url: 'https://mcp.example.com/sse',
                headers: JSON.stringify({ Authorization: 'Bearer token' }),
            })
        );

        await nameField(wrapper).trigger('blur');
        await flushPromises();

        const payload = savedServer();
        expect(payload.url).toBe('https://mcp.example.com/sse');
        expect(JSON.parse(payload.headers as string)).toEqual({ Authorization: 'Bearer token' });
        expect(payload.command).toBeNull();
    });

    it('user is told when the server could not be saved', async () => {
        const consoleError = vi.spyOn(console, 'error').mockImplementation(() => {});
        const wrapper = mountConfig(server());
        fixture.database.exec(
            "CREATE TEMP TRIGGER reject_mcp_write BEFORE UPDATE ON mcp_servers BEGIN SELECT RAISE(ABORT, 'locked'); END;"
        );

        await nameField(wrapper).trigger('blur');
        await flushPromises();

        expect(wrapper.emitted('showAlert')![0]![1]).toBe('error');
        expect(wrapper.emitted('updated')).toBeUndefined();
        consoleError.mockRestore();
    });

    it('user creates a new server as soon as its required fields are filled', async () => {
        vi.useFakeTimers();
        try {
            const wrapper = mountConfig(newServer());

            await nameField(wrapper).setValue('playwright');
            await commandInput(wrapper).setValue('npx');
            await vi.advanceTimersByTimeAsync(900);
            await flushPromises();

            expect(
                fixture.database.prepare('SELECT count(*) AS count FROM mcp_servers').get()?.count
            ).toBe(1);
            expect(savedServer()).toMatchObject({
                name: 'playwright',
                transport_type: 'stdio',
                command: 'npx',
            });
            expect(wrapper.emitted('updated')).toEqual([[true]]);
            wrapper.unmount();
        } finally {
            vi.useRealTimers();
        }
    });

    it('user is not saved repeatedly while still typing a new server', async () => {
        vi.useFakeTimers();
        try {
            const wrapper = mountConfig(newServer());

            await nameField(wrapper).setValue('play');
            await vi.advanceTimersByTimeAsync(400);
            await nameField(wrapper).setValue('playwright');
            await commandInput(wrapper).setValue('npx');
            await vi.advanceTimersByTimeAsync(900);
            await flushPromises();

            expect(
                fixture.database.prepare('SELECT count(*) AS count FROM mcp_servers').get()?.count
            ).toBe(1);
            wrapper.unmount();
        } finally {
            vi.useRealTimers();
        }
    });

    it('user sees the English form labels when the app is in English', () => {
        setLocale('en-US');

        const wrapper = mountConfig(server());

        expect(wrapper.text()).toContain('Server configuration');
        expect(wrapper.text()).toContain('Transport type');
    });
});

beforePresentation(async () => {
    (await createTestWindowPresentation('settings')).install();
});

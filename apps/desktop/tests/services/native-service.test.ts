import {
    type AppUpdateCheckResult,
    type AppUpdateInfo,
    autostart,
    browser,
    type BuiltInBashExecutionResponse,
    builtInTools,
    clipboard,
    type ClipboardPayload,
    database,
    log,
    mcp,
    type McpServerConfig,
    type McpServerStatusInfo,
    type McpToolCallResponse,
    type McpToolDefinition,
    native,
    paths,
    quickSearch,
    type QuickSearchFileItem,
    type QuickSearchResult,
    type QuickSearchStatus,
    type QuickShortcutItem,
    type SearchSurfacePreparation,
    type SearchWindowRegionUpdate,
    shortcut,
    updater,
    window as windowCommands,
} from '@services/NativeService';
import type { SearchWindowState } from '@services/NativeService/types';
import { getLastTauriInvokeCall, interceptTauriInvoke, mockTauriCommand } from '@tests/utils/tauri';
import { describe, expect, expectTypeOf, it } from 'vitest';

import { APP_PRODUCT_CONFIG } from '@/config/product';

async function callAndExpectInvoke(
    call: () => Promise<unknown>,
    expectedCmd: string,
    expectedPayload?: Record<string, unknown>
) {
    const result = await call();

    expect(getLastTauriInvokeCall(expectedCmd)).toEqual({
        cmd: expectedCmd,
        payload: expectedPayload,
    });

    return result;
}

describe('user reaches the native backend through one facade', () => {
    it('user gets every native module from one facade', () => {
        expect(native.window).toBe(windowCommands);
        expect(native.shortcut).toBe(shortcut);
        expect(native.autostart).toBe(autostart);
        expect(native.clipboard).toBe(clipboard);
        expect(native.builtInTools).toBe(builtInTools);
        expect(native.browser).toBe(browser);
        expect(native.log).toBe(log);
        expect(native.database).toBe(database);
        expect(native.paths).toBe(paths);
        expect(native.mcp).toBe(mcp);
        expect(native.quickSearch).toBe(quickSearch);
        expect(native.updater).toBe(updater);
    });
});

describe('user diagnostics reach the native backend', () => {
    const envelope = {
        ts: 1_760_000_000_000,
        level: 3,
        event: 'app.log',
        msg: 'hello',
        attrs: { scope: 'test' },
    };

    it.each([
        {
            name: 'user sends a structured log batch',
            call: () => native.observability.ingest([envelope]),
            cmd: 'obs_ingest',
            payload: { batch: [envelope] },
        },
        {
            name: 'user reads the run identifier',
            call: () => native.observability.runId(),
            cmd: 'obs_run_id',
            payload: undefined,
        },
        {
            name: 'user turns diagnostic mode on',
            call: () => native.observability.setDiagnosticMode(true),
            cmd: 'obs_set_diagnostic_mode',
            payload: { enabled: true },
        },
        {
            name: 'user reads the diagnostic mode status',
            call: () => native.observability.diagnosticModeStatus(),
            cmd: 'obs_diagnostic_mode_status',
            payload: undefined,
        },
        {
            name: 'user previews the diagnostic bundle',
            call: () => native.observability.previewBundle(),
            cmd: 'obs_preview_bundle',
            payload: undefined,
        },
        {
            name: 'user exports the diagnostic bundle',
            call: () => native.observability.exportBundle('/tmp/bundle.zip'),
            cmd: 'obs_export_bundle',
            payload: { destination: '/tmp/bundle.zip' },
        },
        {
            name: 'user dismisses recorded crashes',
            call: () => native.observability.dismissCrashes(),
            cmd: 'obs_dismiss_crashes',
            payload: undefined,
        },
    ])('$name', async ({ call, cmd, payload }) => {
        await callAndExpectInvoke(call, cmd, payload);
    });
});

describe('user drives a browser through the app', () => {
    it.each([
        {
            name: 'user reads browser status',
            call: () => browser.status(),
            cmd: 'browser_status',
            payload: undefined,
        },
        {
            name: 'user starts a managed browser',
            call: () =>
                browser.start({
                    headless: true,
                    startupUrl: 'https://example.test/start',
                }),
            cmd: 'browser_start',
            payload: {
                request: {
                    headless: true,
                    startupUrl: 'https://example.test/start',
                },
            },
        },
        {
            name: 'user discovers installed browsers',
            call: () => browser.discoverInstalled(),
            cmd: 'browser_discover_installed',
            payload: undefined,
        },
        {
            name: 'user reads the default managed browser data path',
            call: () => browser.defaultDataPath(),
            cmd: 'browser_default_data_path',
            payload: undefined,
        },
        {
            name: 'user stops a managed browser session',
            call: () => browser.stop(),
            cmd: 'browser_stop',
            payload: undefined,
        },
        {
            name: 'user navigates the selected tab',
            call: () => browser.navigate({ url: 'https://example.test/path' }),
            cmd: 'browser_navigate',
            payload: { request: { url: 'https://example.test/path' } },
        },
        {
            name: 'user goes back in the browser',
            call: () => browser.back({ tabId: 'tab-1' }),
            cmd: 'browser_back',
            payload: { request: { tabId: 'tab-1' } },
        },
        {
            name: 'user goes forward in the browser',
            call: () => browser.forward({ tabId: 'tab-1' }),
            cmd: 'browser_forward',
            payload: { request: { tabId: 'tab-1' } },
        },
        {
            name: 'user reloads the page',
            call: () => browser.reload({ tabId: 'tab-1' }),
            cmd: 'browser_reload',
            payload: { request: { tabId: 'tab-1' } },
        },
        {
            name: 'user observes browser state',
            call: () => browser.observe({ operation: 'snapshot' }),
            cmd: 'browser_observe',
            payload: { request: { operation: 'snapshot' } },
        },
        {
            name: 'user acts on browser state',
            call: () => browser.act({ action: 'click', ref: 'e1' }),
            cmd: 'browser_act',
            payload: { request: { action: 'click', ref: 'e1' } },
        },
    ])('$name', async ({ call, cmd, payload }) => {
        await callAndExpectInvoke(call, cmd, payload);
    });
});

describe('user works with app windows', () => {
    it.each([
        {
            name: 'user ends native dragging before its completion is acknowledged',
            call: () => windowCommands.dragSearchWindow(),
            cmd: 'drag_search_window',
            payload: undefined,
        },
        {
            name: 'user dismisses a blurred window only if native focus and pin state permit it',
            call: () => windowCommands.reconcileSearchWindowBlur(),
            cmd: 'hide_search_window',
            payload: { ifUnfocused: true },
        },
        {
            name: 'user hides the search window',
            call: () => windowCommands.hideSearchWindow(),
            cmd: 'hide_search_window',
            payload: undefined,
        },
        {
            name: 'user shows the search window',
            call: () => windowCommands.showSearchWindow(),
            cmd: 'show_search_window',
            payload: undefined,
        },
        {
            name: 'reads the current search renderer epoch',
            call: () => windowCommands.getSearchWindowRendererEpoch(),
            cmd: 'get_search_window_renderer_epoch',
            payload: undefined,
        },
        {
            name: 'marks the search renderer ready for its first native show',
            call: () => windowCommands.markSearchWindowReady(12),
            cmd: 'mark_search_window_ready',
            payload: { rendererEpoch: 12 },
        },
        {
            name: 'user updates the tray status indicator',
            call: () => windowCommands.setTrayStatusIndicator('failed'),
            cmd: 'set_tray_status_indicator',
            payload: { status: 'failed' },
        },
        {
            name: 'user clears the tray status indicator',
            call: () => windowCommands.clearTrayStatusIndicator(),
            cmd: 'clear_tray_status_indicator',
            payload: undefined,
        },
        {
            name: 'user shows a session status reminder notification',
            call: () =>
                windowCommands.showSessionStatusReminderNotification({
                    title: 'TouchAI',
                    sessionId: 8,
                    taskId: 'task-1',
                    kind: 'completed',
                    approval: null,
                    body: '任务已完成',
                }),
            cmd: 'show_session_status_reminder_notification',
            payload: {
                payload: {
                    title: 'TouchAI',
                    sessionId: 8,
                    taskId: 'task-1',
                    kind: 'completed',
                    approval: null,
                    body: '任务已完成',
                },
            },
        },
        {
            name: 'user clears session status reminder notifications',
            call: () => windowCommands.clearSessionStatusReminderNotifications(),
            cmd: 'clear_session_status_reminder_notifications',
            payload: undefined,
        },
        {
            name: 'user opens the settings window',
            call: () => windowCommands.openSettingsWindow(),
            cmd: 'open_settings_window',
            payload: undefined,
        },
        {
            name: 'user closes the tray menu',
            call: () => windowCommands.closeTrayMenu(),
            cmd: 'close_tray_menu',
            payload: undefined,
        },
        {
            name: 'user syncs app blur policy for the search surface',
            call: () => windowCommands.setSearchSurfaceHideOnAppBlur(true),
            cmd: 'set_search_surface_hide_on_app_blur',
            payload: { shouldHide: true },
        },
        {
            name: 'user syncs manual height override policy',
            call: () => windowCommands.setSearchWindowAllowHeightOverride(false),
            cmd: 'set_search_window_allow_height_override',
            payload: { allow: false },
        },
        {
            name: 'user resizes the search window height',
            call: () =>
                windowCommands.resizeWindowHeight({
                    targetHeight: 420,
                    center: true,
                    animate: true,
                    respectManualOverride: false,
                }),
            cmd: 'resize_window_height',
            payload: {
                params: {
                    targetHeight: 420,
                    center: true,
                    animate: true,
                    respectManualOverride: false,
                },
            },
        },
        {
            name: 'user updates the search window minimum size',
            call: () =>
                windowCommands.setSearchWindowMinSize({
                    minWidth: 420,
                    minHeight: 60,
                    maxHeight: 720,
                }),
            cmd: 'set_search_window_min_size',
            payload: {
                size: {
                    minWidth: 420,
                    minHeight: 60,
                    maxHeight: 720,
                },
            },
        },
    ])('$name', async ({ call, cmd, payload }) => {
        await callAndExpectInvoke(call, cmd, payload);
    });

    it('returns the native acknowledgement for a search window region update', async () => {
        const response: SearchWindowRegionUpdate = { status: 'applied', generation: 7 };
        const regions = [
            { x: 24, y: 32, width: 750, height: 420, cornerRadius: 12 },
            { x: 454, y: 96, width: 320, height: 384, cornerRadius: 12 },
        ];
        mockTauriCommand('set_search_window_regions', response);
        const preparation: SearchSurfacePreparation = {
            rendererEpoch: 2,
            showEpoch: 4,
            hostEpoch: 6,
            source: 'shortcut',
            physicalViewport: { x: -1920, y: 0, width: 1920, height: 1040 },
            scaleFactor: 1.25,
        };
        expectTypeOf(windowCommands.setSearchWindowRegions).returns.toEqualTypeOf<
            Promise<SearchWindowRegionUpdate>
        >();

        await expect(
            callAndExpectInvoke(
                () => windowCommands.setSearchWindowRegions(regions, 7, preparation),
                'set_search_window_regions',
                { generation: 7, regions, preparation }
            )
        ).resolves.toEqual(response);
    });

    it('returns a pending preparation from the epoch-aware renderer handshake', async () => {
        const preparation: SearchSurfacePreparation = {
            rendererEpoch: 2,
            showEpoch: 4,
            hostEpoch: 6,
            source: 'notification',
            physicalViewport: { x: 0, y: 0, width: 2560, height: 1400 },
            scaleFactor: 1.5,
        };
        mockTauriCommand('mark_search_window_ready', preparation);

        await expect(windowCommands.markSearchWindowReady(2)).resolves.toEqual(preparation);
    });

    it('user sees the backend clamp the search window defaults', async () => {
        const response = { width: 960, height: 320 };
        mockTauriCommand('set_search_window_defaults', response);

        await expect(
            callAndExpectInvoke(
                () =>
                    windowCommands.setSearchWindowDefaults({
                        width: 960,
                        height: 320,
                    }),
                'set_search_window_defaults',
                {
                    defaults: {
                        width: 960,
                        height: 320,
                    },
                }
            )
        ).resolves.toEqual(response);
    });

    it('user sees the current search window state', async () => {
        const response: SearchWindowState = {
            defaults: { width: 750, height: 60 },
            currentWidth: 900,
            currentHeight: 420,
            heightMode: 'manual_override',
            monitorHost: true,
        };
        mockTauriCommand('get_search_window_state', response);

        await expect(
            callAndExpectInvoke(
                () => windowCommands.getSearchWindowState(),
                'get_search_window_state'
            )
        ).resolves.toEqual(response);
    });

    it('commits a logical panel resize with both the frontend origin and final size', async () => {
        const response: SearchWindowState = {
            defaults: { width: 750, height: 60 },
            currentWidth: 900,
            currentHeight: 420,
            heightMode: 'manual_override',
            monitorHost: true,
        };
        mockTauriCommand('commit_search_panel_resize', response);

        await expect(
            callAndExpectInvoke(
                () =>
                    windowCommands.commitSearchPanelResize({
                        from: { width: 750, height: 300 },
                        to: { width: 900, height: 420 },
                        placement: 'preserve-origin',
                        physicalOrigin: { x: -1200, y: 40 },
                    }),
                'commit_search_panel_resize',
                {
                    resize: {
                        from: { width: 750, height: 300 },
                        to: { width: 900, height: 420 },
                        placement: 'preserve-origin',
                        physicalOrigin: { x: -1200, y: 40 },
                    },
                }
            )
        ).resolves.toEqual(response);
    });

    it('user sees a window backend failure instead of a silent success', async () => {
        const backendError = new Error('window backend unavailable');
        interceptTauriInvoke((call, next) => {
            if (call.cmd === 'hide_search_window') {
                throw backendError;
            }

            return next();
        });

        await expect(windowCommands.hideSearchWindow()).rejects.toThrow(backendError);
    });
});

describe('user data is read and written through typed database operations', () => {
    it('user sends one typed operation to the database runtime', async () => {
        mockTauriCommand('database_operation', 'zh-CN');

        await expect(
            callAndExpectInvoke(
                () => database.operation({ kind: 'setting_get', key: 'language' }),
                'database_operation',
                { request: { kind: 'setting_get', key: 'language' } }
            )
        ).resolves.toBe('zh-CN');
    });

    it.each([
        {
            name: 'user exports a database backup',
            call: () => database.exportBackup('D:/backup/touchai.db'),
            cmd: 'database_export_backup',
            payload: { request: { targetPath: 'D:/backup/touchai.db' } },
        },
        {
            name: 'user imports a database backup',
            call: () =>
                database.importBackup({
                    sourcePath: 'D:/backup/touchai.db',
                    mode: 'full',
                }),
            cmd: 'database_import_backup',
            payload: {
                request: {
                    sourcePath: 'D:/backup/touchai.db',
                    mode: 'full',
                },
            },
        },
    ])('$name', async ({ call, cmd, payload }) => {
        await callAndExpectInvoke(call, cmd, payload);
    });

    it('user sees the stable database error code and message', async () => {
        const backendError = new Error('database busy');
        Object.assign(backendError, { code: 'database-busy' });
        interceptTauriInvoke((call, next) => {
            if (call.cmd === 'database_operation') {
                throw backendError;
            }

            return next();
        });

        await expect(
            database.operation({ kind: 'setting_get', key: 'language' })
        ).rejects.toMatchObject({
            message: 'database busy',
            code: 'database-busy',
        });
    });

    it.each([
        {
            name: 'user sees a structured native error object as an Error',
            backendError: { message: 'database locked', code: 'database-locked' },
            message: 'database locked',
            code: 'database-locked',
        },
        {
            name: 'user sees a structured native error without a code',
            backendError: { message: 'database closed' },
            message: 'database closed',
            code: undefined,
        },
        {
            name: 'user sees an object without a message as a stable Error',
            backendError: { code: 'database-unknown' },
            message: '[object Object]',
            code: undefined,
        },
        {
            name: 'user sees a primitive native error as an Error',
            backendError: 'database offline',
            message: 'database offline',
            code: undefined,
        },
        {
            name: 'user sees a missing native error as a stable Error',
            backendError: null,
            message: 'null',
            code: undefined,
        },
    ])('$name', async ({ backendError, message, code }) => {
        interceptTauriInvoke((call, next) => {
            if (call.cmd === 'database_operation') {
                throw backendError;
            }

            return next();
        });

        const error = await database
            .operation({ kind: 'setting_get', key: 'language' })
            .catch((caught: unknown) => caught);

        expect(error).toBeInstanceOf(Error);
        expect(error).toMatchObject({ message });
        if (code) {
            expect(error).toMatchObject({ code });
        }
    });
});

describe('user uses MCP tools', () => {
    const serverConfig: McpServerConfig = {
        id: 7,
        name: 'filesystem',
        transport_type: 'stdio',
        command: 'node',
        args: ['server.js'],
        enabled: true,
        tool_timeout: 30_000,
    };

    it('user connects an MCP server with its declared transport', async () => {
        await callAndExpectInvoke(() => mcp.connectServer(serverConfig), 'mcp_connect_server', {
            config: serverConfig,
            connectionOrigin: 'user',
        });
    });

    it('user lists the tools an MCP server exposes', async () => {
        const tools: McpToolDefinition[] = [
            {
                name: 'read_file',
                description: 'Read a file from disk.',
                input_schema: { type: 'object' },
            },
        ];
        mockTauriCommand('mcp_list_tools', tools);

        await expect(
            callAndExpectInvoke(() => mcp.listTools(7), 'mcp_list_tools', { serverId: 7 })
        ).resolves.toEqual(tools);
    });

    it('user calls an MCP tool with the native argument shape', async () => {
        const response: McpToolCallResponse = {
            success: true,
            content: [{ type: 'text', text: 'ok' }],
            is_error: false,
        };
        mockTauriCommand('mcp_call_tool', response);

        await expect(
            callAndExpectInvoke(
                () => mcp.callTool(7, 'read_file', { path: 'README.md' }),
                'mcp_call_tool',
                {
                    serverId: 7,
                    toolName: 'read_file',
                    arguments: { path: 'README.md' },
                }
            )
        ).resolves.toEqual(response);
    });

    it('user sees current and aggregate MCP connection status', async () => {
        const singleStatus: McpServerStatusInfo = {
            server_id: 7,
            status: 'connected',
            version: '1.0.0',
        };
        const allStatuses: McpServerStatusInfo[] = [
            singleStatus,
            {
                server_id: 9,
                status: 'error',
                error: 'spawn failed',
            },
        ];
        mockTauriCommand('mcp_get_client_status', singleStatus);
        mockTauriCommand('mcp_get_all_client_statuses', allStatuses);

        await expect(
            callAndExpectInvoke(() => mcp.getServerStatus(7), 'mcp_get_client_status', {
                serverId: 7,
            })
        ).resolves.toEqual(singleStatus);

        await expect(
            callAndExpectInvoke(() => mcp.getAllServerStatuses(), 'mcp_get_all_client_statuses')
        ).resolves.toEqual(allStatuses);
    });

    it.each([
        {
            name: 'user disconnects one server',
            call: () => mcp.disconnectServer(7),
            cmd: 'mcp_disconnect_server',
            payload: { serverId: 7 },
        },
        {
            name: 'user disconnects all servers',
            call: () => mcp.disconnectAll(),
            cmd: 'mcp_disconnect_all',
            payload: undefined,
        },
    ])('$name', async ({ call, cmd, payload }) => {
        await callAndExpectInvoke(call, cmd, payload);
    });

    it('user sees an MCP tool failure instead of a silent success', async () => {
        const backendError = new Error('tool execution failed');
        interceptTauriInvoke((call, next) => {
            if (call.cmd === 'mcp_call_tool') {
                throw backendError;
            }

            return next();
        });

        await expect(mcp.callTool(7, 'read_file', { path: 'README.md' })).rejects.toThrow(
            backendError
        );
    });
});

describe('user searches files and shortcuts', () => {
    it('user searches shortcuts with the default page size', async () => {
        const response: QuickSearchResult = {
            shortcuts: [{ name: 'TouchAI', path: 'D:/TouchAI.lnk', source: 'desktop_user' }],
            files: [],
            total_files: 0,
            total_results: 1,
            next_offset: 0,
        };
        mockTauriCommand('quick_search_search_shortcuts', response);

        await expect(
            callAndExpectInvoke(
                () => quickSearch.searchShortcuts('touch'),
                'quick_search_search_shortcuts',
                { query: 'touch', pageSize: 60, offset: 0 }
            )
        ).resolves.toEqual(response);
    });

    it('user searches files with shortcut inclusion sent in snake case', async () => {
        const response: QuickSearchFileItem[] = [{ name: 'README.md', path: 'D:/README.md' }];
        mockTauriCommand('quick_search_search_files', response);

        await expect(
            callAndExpectInvoke(
                () =>
                    quickSearch.searchFiles('readme', 20, {
                        includeShortcuts: true,
                    }),
                'quick_search_search_files',
                {
                    query: 'readme',
                    limit: 20,
                    include_shortcuts: true,
                }
            )
        ).resolves.toEqual(response);
    });

    it('user gets recent reference suggestions from accepted paths', async () => {
        const response: QuickShortcutItem[] = [
            { name: 'Plan.md', path: 'D:/Docs/Plan.md', source: 'file' },
        ];
        mockTauriCommand('quick_search_file_reference_suggestions', response);

        await expect(
            callAndExpectInvoke(
                () => quickSearch.getFileReferenceSuggestions(['D:/Docs/Plan.md'], 12),
                'quick_search_file_reference_suggestions',
                { recentPaths: ['D:/Docs/Plan.md'], limit: 12 }
            )
        ).resolves.toEqual(response);
    });

    it('user loads icons and runtime status with default sizes', async () => {
        const icon = 'data:image/png;base64,abc';
        const icons = { 'D:/TouchAI.lnk': icon };
        const thumbnails = { 'D:/cover.png': icon };
        const status: QuickSearchStatus = {
            provider: 'everything',
            db_loaded: true,
            index_warmed: true,
            last_refresh_ms: 5_000,
            last_error: null,
        };
        mockTauriCommand('quick_search_get_shortcut_icon', icon);
        mockTauriCommand('quick_search_get_shortcut_icons', icons);
        mockTauriCommand('quick_search_get_image_thumbnails', thumbnails);
        mockTauriCommand('quick_search_get_status', status);

        await expect(
            callAndExpectInvoke(
                () => quickSearch.getShortcutIcon('D:/TouchAI.lnk'),
                'quick_search_get_shortcut_icon',
                { path: 'D:/TouchAI.lnk', size: 48 }
            )
        ).resolves.toBe(icon);

        await expect(
            callAndExpectInvoke(
                () => quickSearch.getShortcutIcons(['D:/TouchAI.lnk']),
                'quick_search_get_shortcut_icons',
                { paths: ['D:/TouchAI.lnk'], size: 48 }
            )
        ).resolves.toEqual(icons);

        await expect(
            callAndExpectInvoke(
                () => quickSearch.getImageThumbnails(['D:/cover.png']),
                'quick_search_get_image_thumbnails',
                { paths: ['D:/cover.png'], size: 48 }
            )
        ).resolves.toEqual(thumbnails);

        await expect(
            callAndExpectInvoke(() => quickSearch.getStatus(), 'quick_search_get_status')
        ).resolves.toEqual(status);
    });

    it('user prepares the search index with an explicit force flag', async () => {
        await callAndExpectInvoke(
            () => quickSearch.prepareIndex(true),
            'quick_search_prepare_index',
            { force: true }
        );
    });

    it('user sees an indexing failure instead of a silent success', async () => {
        const backendError = new Error('indexing failed');
        interceptTauriInvoke((call, next) => {
            if (call.cmd === 'quick_search_prepare_index') {
                throw backendError;
            }

            return next();
        });

        await expect(quickSearch.prepareIndex()).rejects.toThrow(backendError);
    });
});

describe('user uses clipboard, shortcuts, autostart, and updates', () => {
    it('user checks, downloads, and installs app updates', async () => {
        const update: AppUpdateInfo = {
            version: '0.2.0',
            fileName: `${APP_PRODUCT_CONFIG.identifier}-0.2.0-full.nupkg`,
            notes: 'Bug fixes',
            sizeBytes: 12_000_000,
        };
        const response: AppUpdateCheckResult = {
            status: 'available',
            channel: 'beta',
            currentVersion: '0.1.0',
            latest: {
                version: '0.2.0',
                tag: 'v0.2.0',
                releaseUrl: `${APP_PRODUCT_CONFIG.repository.releasesUrl}/tag/v0.2.0`,
                publishedAt: '2026-05-22T09:00:00.000Z',
                prerelease: false,
                releaseNotes: '## 更新日志\n\n- 修复问题',
                downloads: [
                    {
                        kind: 'installer',
                        name: 'TouchAI-0.2.0-windows.msi',
                        url: `${APP_PRODUCT_CONFIG.services.updates.baseUrl}/TouchAI-0.2.0-windows.msi`,
                        sizeBytes: 12_000_000,
                    },
                ],
            },
            update,
            requirement: {
                required: false,
                minimumSupportedVersion: null,
                requiredSeverity: null,
                requiredReason: null,
                targetSatisfiesRequirement: true,
            },
        };

        mockTauriCommand('updater_check_for_updates', response);
        mockTauriCommand('updater_download_update', update);
        mockTauriCommand('updater_install_update', true);

        await expect(
            callAndExpectInvoke(
                () => updater.checkForUpdates('beta'),
                'updater_check_for_updates',
                {
                    channel: 'beta',
                }
            )
        ).resolves.toEqual(response);

        await expect(
            callAndExpectInvoke(
                () => updater.downloadUpdate('beta', update.version, update.fileName),
                'updater_download_update',
                {
                    channel: 'beta',
                    version: update.version,
                    fileName: update.fileName,
                }
            )
        ).resolves.toEqual(update);

        await expect(
            callAndExpectInvoke(
                () =>
                    updater.installUpdate('beta', update.version, update.fileName, {
                        updateOperationId: '11111111-1111-4111-8111-111111111111',
                        source: 'user',
                    }),
                'updater_install_update',
                {
                    channel: 'beta',
                    version: update.version,
                    fileName: update.fileName,
                    analytics: {
                        updateOperationId: '11111111-1111-4111-8111-111111111111',
                        source: 'user',
                    },
                }
            )
        ).resolves.toBe(true);
    });

    it('user reads clipboard payloads and consumes shortcut snapshots', async () => {
        const payload: ClipboardPayload = {
            snapshotId: 'snapshot-1',
            observedAt: 1_234,
            text: 'TouchAI',
            imagePaths: [],
            filePaths: ['D:/touchai.txt'],
            fragments: [{ type: 'text', text: 'TouchAI' }],
        };
        mockTauriCommand('read_clipboard_payload', payload);
        mockTauriCommand('consume_shortcut_auto_paste_payload', payload);

        await expect(
            callAndExpectInvoke(() => clipboard.readClipboardPayload(), 'read_clipboard_payload')
        ).resolves.toEqual(payload);

        await expect(
            callAndExpectInvoke(
                () => clipboard.consumeShortcutAutoPastePayload(30_000),
                'consume_shortcut_auto_paste_payload',
                { maxAgeMs: 30_000 }
            )
        ).resolves.toEqual(payload);
    });

    it.each([
        {
            name: 'user writes clipboard text',
            call: () => clipboard.writeClipboardText('TouchAI'),
            cmd: 'write_clipboard_text',
            payload: { text: 'TouchAI' },
        },
        {
            name: 'user registers the global shortcut',
            call: () => shortcut.registerGlobalShortcut('Ctrl+Shift+K'),
            cmd: 'register_global_shortcut',
            payload: { shortcut: 'Ctrl+Shift+K' },
        },
        {
            name: 'user syncs search surface shortcuts',
            call: () =>
                shortcut.setSearchSurfaceShortcuts([
                    {
                        actionId: 'search.model.toggle',
                        shortcut: 'Mod+M',
                    },
                ]),
            cmd: 'set_search_surface_shortcuts',
            payload: {
                entries: [
                    {
                        actionId: 'search.model.toggle',
                        shortcut: 'Mod+M',
                    },
                ],
            },
        },
        {
            name: 'user enables autostart',
            call: () => autostart.enableAutostart(),
            cmd: 'enable_autostart',
            payload: undefined,
        },
        {
            name: 'user disables autostart',
            call: () => autostart.disableAutostart(),
            cmd: 'disable_autostart',
            payload: undefined,
        },
        {
            name: 'user writes an app log entry through the native log plugin',
            call: () => log.log({ level: 3, message: 'TouchAI ready', file: 'main.ts', line: 7 }),
            cmd: 'plugin:log|log',
            payload: { level: 3, message: 'TouchAI ready', file: 'main.ts', line: 7 },
        },
    ])('$name', async ({ call, cmd, payload }) => {
        await callAndExpectInvoke(call, cmd, payload);
    });

    it('user sees autostart status, app paths, shortcut status, and tool results', async () => {
        const bashResponse: BuiltInBashExecutionResponse = {
            command: 'dir',
            shell: 'powershell',
            workingDirectory: 'D:/Project/TouchAI',
            exitCode: 0,
            success: true,
            timedOut: false,
            cancelled: false,
            durationMs: 18,
            stdout: 'TouchAI',
            stderr: '',
            combinedOutput: 'TouchAI',
        };
        mockTauriCommand('is_autostart_enabled', true);
        mockTauriCommand('get_app_directory_path', 'D:/TouchAI/data');
        mockTauriCommand('get_shortcut_status', [true, null]);
        mockTauriCommand('built_in_tools_execute_bash', bashResponse);
        mockTauriCommand('built_in_tools_cancel_bash', true);

        await expect(
            callAndExpectInvoke(() => autostart.isAutostartEnabled(), 'is_autostart_enabled')
        ).resolves.toBe(true);

        await expect(
            callAndExpectInvoke(() => paths.getAppDirectoryPath('DATA'), 'get_app_directory_path', {
                directory: 'DATA',
            })
        ).resolves.toBe('D:/TouchAI/data');

        await expect(
            callAndExpectInvoke(() => shortcut.getShortcutStatus(), 'get_shortcut_status')
        ).resolves.toEqual([true, null]);

        await expect(
            callAndExpectInvoke(
                () =>
                    builtInTools.executeBash({
                        executionId: 'exec-1',
                        command: 'dir',
                        timeoutMs: 10_000,
                    }),
                'built_in_tools_execute_bash',
                {
                    request: {
                        executionId: 'exec-1',
                        command: 'dir',
                        timeoutMs: 10_000,
                    },
                }
            )
        ).resolves.toEqual(bashResponse);

        await expect(
            callAndExpectInvoke(
                () => builtInTools.cancelBash('exec-1'),
                'built_in_tools_cancel_bash',
                { executionId: 'exec-1' }
            )
        ).resolves.toBe(true);
    });
});

import {
    type AppUpdateCheckResult,
    type AppUpdateInfo,
    autostart,
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
    shortcut,
    updater,
    window as windowCommands,
} from '@services/NativeService';
import type { DatabaseQueryResponse } from '@services/NativeService/database';
import type { SearchWindowState } from '@services/NativeService/types';
import { getLastTauriInvokeCall, interceptTauriInvoke, mockTauriCommand } from '@tests/utils/tauri';
import { describe, expect, it } from 'vitest';

import { APP_PRODUCT_CONFIG } from '@/config/product';

async function callAndExpectInvoke<T>(
    call: () => Promise<T>,
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

describe('NativeService barrel', () => {
    it('exposes the same module instances through the native facade', () => {
        expect(native.window).toBe(windowCommands);
        expect(native.shortcut).toBe(shortcut);
        expect(native.autostart).toBe(autostart);
        expect(native.clipboard).toBe(clipboard);
        expect(native.builtInTools).toBe(builtInTools);
        expect(native.log).toBe(log);
        expect(native.database).toBe(database);
        expect(native.paths).toBe(paths);
        expect(native.mcp).toBe(mcp);
        expect(native.quickSearch).toBe(quickSearch);
        expect(native.updater).toBe(updater);
    });
});

describe('NativeService window boundary', () => {
    it.each([
        {
            name: 'hides the search window',
            call: () => windowCommands.hideSearchWindow(),
            cmd: 'hide_search_window',
            payload: undefined,
        },
        {
            name: 'shows the search window',
            call: () => windowCommands.showSearchWindow(),
            cmd: 'show_search_window',
            payload: undefined,
        },
        {
            name: 'opens the settings window',
            call: () => windowCommands.openSettingsWindow(),
            cmd: 'open_settings_window',
            payload: undefined,
        },
        {
            name: 'closes the tray menu',
            call: () => windowCommands.closeTrayMenu(),
            cmd: 'close_tray_menu',
            payload: undefined,
        },
        {
            name: 'preloads popup windows',
            call: () => windowCommands.preloadPopupWindows(),
            cmd: 'preload_popup_windows',
            payload: undefined,
        },
        {
            name: 'resets search window bounds',
            call: () => windowCommands.resetSearchWindowBounds(),
            cmd: 'reset_search_window_bounds',
            payload: undefined,
        },
        {
            name: 'registers popup configs',
            call: () =>
                windowCommands.registerPopupConfigs([
                    { id: 'session-history-popup', width: 320, height: 384 },
                ]),
            cmd: 'register_popup_configs',
            payload: {
                configs: [{ id: 'session-history-popup', width: 320, height: 384 }],
            },
        },
        {
            name: 'shows a popup window',
            call: () =>
                windowCommands.showPopupWindow({
                    popupId: 'popup-model-dropdown-popup:1',
                    popupSessionVersion: 1,
                    popupType: 'model-dropdown-popup',
                    width: 320,
                    height: 384,
                    x: 80,
                    y: 120,
                    windowLabel: 'popup-model-dropdown-popup',
                }),
            cmd: 'show_popup_window',
            payload: {
                params: {
                    popupId: 'popup-model-dropdown-popup:1',
                    popupSessionVersion: 1,
                    popupType: 'model-dropdown-popup',
                    width: 320,
                    height: 384,
                    x: 80,
                    y: 120,
                    windowLabel: 'popup-model-dropdown-popup',
                },
            },
        },
        {
            name: 'hides a popup window',
            call: () =>
                windowCommands.hidePopupWindow({
                    popupId: 'popup-model-dropdown-popup:1',
                    popupSessionVersion: 1,
                    windowLabel: 'popup-model-dropdown-popup',
                }),
            cmd: 'hide_popup_window',
            payload: {
                params: {
                    popupId: 'popup-model-dropdown-popup:1',
                    popupSessionVersion: 1,
                    windowLabel: 'popup-model-dropdown-popup',
                },
            },
        },
        {
            name: 'syncs app blur policy for the search surface',
            call: () => windowCommands.setSearchSurfaceHideOnAppBlur(true),
            cmd: 'set_search_surface_hide_on_app_blur',
            payload: { shouldHide: true },
        },
        {
            name: 'syncs manual height override policy',
            call: () => windowCommands.setSearchWindowAllowHeightOverride(false),
            cmd: 'set_search_window_allow_height_override',
            payload: { allow: false },
        },
        {
            name: 'resizes the search window height',
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
            name: 'updates the search window minimum size',
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

    it('returns the clamped search window defaults from the backend', async () => {
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

    it('returns the current search window runtime snapshot', async () => {
        const response: SearchWindowState = {
            defaults: { width: 750, height: 60 },
            currentWidth: 900,
            currentHeight: 420,
            heightMode: 'manual_override',
        };
        mockTauriCommand('get_search_window_state', response);

        await expect(
            callAndExpectInvoke(
                () => windowCommands.getSearchWindowState(),
                'get_search_window_state'
            )
        ).resolves.toEqual(response);
    });

    it('rethrows backend invoke failures', async () => {
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

describe('NativeService database boundary', () => {
    it('forwards query requests and returns rows', async () => {
        const response: DatabaseQueryResponse = {
            rows: [{ id: 1, title: 'TouchAI' }],
            rowsAffected: 1,
            lastInsertId: 1,
        };
        mockTauriCommand('database_query', response);

        await expect(
            callAndExpectInvoke(
                () =>
                    database.query({
                        sql: 'select * from sessions where id = ?',
                        params: [1],
                        method: 'get',
                    }),
                'database_query',
                {
                    request: {
                        sql: 'select * from sessions where id = ?',
                        params: [1],
                        method: 'get',
                    },
                }
            )
        ).resolves.toEqual(response);
    });

    it('forwards batch requests', async () => {
        const response: DatabaseQueryResponse[] = [
            { rows: [], rowsAffected: 1, lastInsertId: 1 },
            { rows: [{ count: 1 }], rowsAffected: 0, lastInsertId: null },
        ];
        mockTauriCommand('database_batch', response);

        await expect(
            callAndExpectInvoke(
                () =>
                    database.batch([
                        {
                            sql: 'insert into sessions(title) values (?)',
                            params: ['TouchAI'],
                            method: 'run',
                        },
                        {
                            sql: 'select count(*) as count from sessions',
                            method: 'get',
                        },
                    ]),
                'database_batch',
                {
                    requests: [
                        {
                            sql: 'insert into sessions(title) values (?)',
                            params: ['TouchAI'],
                            method: 'run',
                        },
                        {
                            sql: 'select count(*) as count from sessions',
                            method: 'get',
                        },
                    ],
                }
            )
        ).resolves.toEqual(response);
    });

    it('starts explicit transactions with the requested behavior', async () => {
        mockTauriCommand('database_tx_begin', 'tx_123');

        await expect(
            callAndExpectInvoke(() => database.txBegin('immediate'), 'database_tx_begin', {
                behavior: 'immediate',
            })
        ).resolves.toBe('tx_123');
    });

    it('runs transactional commands against the tracked transaction id', async () => {
        const response: DatabaseQueryResponse = {
            rows: [{ applied: true }],
            rowsAffected: 1,
            lastInsertId: null,
        };
        mockTauriCommand('database_tx_query', response);

        await expect(
            callAndExpectInvoke(
                () =>
                    database.txQuery('tx_123', {
                        sql: 'update sessions set pinned = ? where id = ?',
                        params: [true, 7],
                        method: 'run',
                    }),
                'database_tx_query',
                {
                    txId: 'tx_123',
                    request: {
                        sql: 'update sessions set pinned = ? where id = ?',
                        params: [true, 7],
                        method: 'run',
                    },
                }
            )
        ).resolves.toEqual(response);
    });

    it.each([
        {
            name: 'commits a transaction',
            call: () => database.txCommit('tx_123'),
            cmd: 'database_tx_commit',
            payload: { txId: 'tx_123' },
        },
        {
            name: 'rolls back a transaction',
            call: () => database.txRollback('tx_123'),
            cmd: 'database_tx_rollback',
            payload: { txId: 'tx_123' },
        },
        {
            name: 'exports a database backup',
            call: () => database.exportBackup('D:/backup/touchai.db'),
            cmd: 'database_export_backup',
            payload: { targetPath: 'D:/backup/touchai.db' },
        },
        {
            name: 'imports a database backup',
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

    it('rethrows query failures', async () => {
        const backendError = new Error('database busy');
        interceptTauriInvoke((call, next) => {
            if (call.cmd === 'database_query') {
                throw backendError;
            }

            return next();
        });

        await expect(
            database.query({
                sql: 'select 1',
                method: 'get',
            })
        ).rejects.toThrow(backendError);
    });
});

describe('NativeService MCP boundary', () => {
    const serverConfig: McpServerConfig = {
        id: 7,
        name: 'filesystem',
        transport_type: 'stdio',
        command: 'node',
        args: ['server.js'],
        enabled: true,
        tool_timeout: 30_000,
    };

    it('connects a server with the declared transport config', async () => {
        await callAndExpectInvoke(() => mcp.connectServer(serverConfig), 'mcp_connect_server', {
            config: serverConfig,
        });
    });

    it('lists server tools', async () => {
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

    it('calls a tool with the tauri argument payload shape', async () => {
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

    it('returns current and aggregate connection status snapshots', async () => {
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
            name: 'disconnects one server',
            call: () => mcp.disconnectServer(7),
            cmd: 'mcp_disconnect_server',
            payload: { serverId: 7 },
        },
        {
            name: 'disconnects all servers',
            call: () => mcp.disconnectAll(),
            cmd: 'mcp_disconnect_all',
            payload: undefined,
        },
    ])('$name', async ({ call, cmd, payload }) => {
        await callAndExpectInvoke(call, cmd, payload);
    });

    it('rethrows tool invocation failures', async () => {
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

describe('NativeService quick search boundary', () => {
    it('searches shortcuts with the default page size', async () => {
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

    it('searches files with shortcut inclusion normalized to snake case', async () => {
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

    it('loads icons and runtime status with default sizes', async () => {
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

    it('prepares the search index with the explicit force flag', async () => {
        await callAndExpectInvoke(
            () => quickSearch.prepareIndex(true),
            'quick_search_prepare_index',
            { force: true }
        );
    });

    it('rethrows indexing failures', async () => {
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

describe('NativeService supporting boundaries', () => {
    it('checks, downloads, and installs app updates through updater commands', async () => {
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
            callAndExpectInvoke(() => updater.downloadUpdate(), 'updater_download_update')
        ).resolves.toEqual(update);

        await expect(
            callAndExpectInvoke(() => updater.installUpdate(), 'updater_install_update')
        ).resolves.toBe(true);
    });

    it('reads clipboard payloads and consumes shortcut snapshots', async () => {
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
            name: 'writes clipboard text',
            call: () => clipboard.writeClipboardText('TouchAI'),
            cmd: 'write_clipboard_text',
            payload: { text: 'TouchAI' },
        },
        {
            name: 'registers the global shortcut',
            call: () => shortcut.registerGlobalShortcut('Ctrl+Shift+K'),
            cmd: 'register_global_shortcut',
            payload: { shortcut: 'Ctrl+Shift+K' },
        },
        {
            name: 'enables autostart',
            call: () => autostart.enableAutostart(),
            cmd: 'enable_autostart',
            payload: undefined,
        },
        {
            name: 'disables autostart',
            call: () => autostart.disableAutostart(),
            cmd: 'disable_autostart',
            payload: undefined,
        },
        {
            name: 'logs through the tauri log plugin command',
            call: () => log.log({ level: 3, message: 'TouchAI ready', file: 'main.ts', line: 7 }),
            cmd: 'plugin:log|log',
            payload: { level: 3, message: 'TouchAI ready', file: 'main.ts', line: 7 },
        },
    ])('$name', async ({ call, cmd, payload }) => {
        await callAndExpectInvoke(call, cmd, payload);
    });

    it('returns autostart status, app paths, shortcut status, and built-in tool results', async () => {
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

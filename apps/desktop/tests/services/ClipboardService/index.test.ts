import { posix } from 'node:path';

import {
    closeTestDatabases,
    openMigratedDatabase,
    routeQueriesTo,
} from '@tests/database/sqliteHarness';
import { mockTauriCommand } from '@tests/utils/tauri';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { afterEach } from 'vitest';

import { initializeSearchWindow } from '@/app/bootstrap/search';
import type { ClipboardPayload } from '@/platform/native/types';

const files = vi.hoisted(() => new Map<string, Uint8Array>());
vi.mock('@tauri-apps/plugin-fs', () => ({
    exists: async (path: string) => files.has(path),
    mkdir: async () => {},
    writeFile: async (path: string, data: Uint8Array) => {
        files.set(path, data.slice());
    },
}));
vi.mock('@tauri-apps/api/path', () => ({
    join: (...parts: string[]) => Promise.resolve(posix.join(...parts)),
}));
vi.mock('tauri-plugin-fs-pro-api', () => ({ icon: async () => '/fixture/icon' }));

let host: ReturnType<typeof initializeSearchWindow>;
let database: ReturnType<typeof openMigratedDatabase>;
let clipboardService: NonNullable<typeof host.clipboard>;
afterEach(() => {
    host?.dispose();
    closeTestDatabases();
});

function createClipboardData(data: Record<string, string>): DataTransfer {
    return {
        getData: vi.fn((type: string) => data[type] ?? ''),
    } as unknown as DataTransfer;
}

function createClipboardDataWithFiles(
    data: Record<string, string>,
    files: File[],
    items?: Array<{ kind: string; getAsFile: () => File | null }>
): DataTransfer {
    return {
        getData: vi.fn((type: string) => data[type] ?? ''),
        files,
        items: items ?? [],
    } as unknown as DataTransfer;
}

function createNativePayload(overrides: Partial<ClipboardPayload>): ClipboardPayload {
    return {
        snapshotId: 'native-1',
        observedAt: 1,
        text: null,
        html: null,
        htmlSourceUrl: null,
        htmlImages: [],
        imagePaths: [],
        filePaths: [],
        fragments: [],
        ...overrides,
    };
}

describe('user pastes into the search box', () => {
    beforeEach(() => {
        vi.clearAllMocks();
        files.clear();
        database = openMigratedDatabase();
        routeQueriesTo(database);
        mockTauriCommand('get_app_directory_path', '/fixture/cache');
        host = initializeSearchWindow('main');
        clipboardService = host.clipboard!;
    });

    it('user still gets the pasted text when the native clipboard read fails', async () => {
        mockTauriCommand('read_clipboard_payload', () => {
            throw new Error('clipboard busy');
        });

        const payload = await clipboardService.readExplicitPastePayload(
            createClipboardData({
                'text/plain': 'Line one\nLine two',
            })
        );

        expect(payload?.text).toBe('Line one\nLine two');
        expect(payload?.fragments).toEqual([{ type: 'text', text: 'Line one\nLine two' }]);
    });

    it('user gets pasted table text as plain rows with native attachments kept', async () => {
        mockTauriCommand(
            'read_clipboard_payload',
            createNativePayload({
                imagePaths: ['D:/clip/image.png'],
                fragments: [{ type: 'image', path: 'D:/clip/image.png' }],
            })
        );

        const payload = await clipboardService.readExplicitPastePayload(
            createClipboardData({
                'text/plain': 'Name\tAge\nAlice\t28',
                'text/html':
                    '<table><tr><th>Name</th><th>Age</th></tr><tr><td>Alice</td><td>28</td></tr></table>',
            })
        );

        expect(payload?.text).toBe('Name\tAge\nAlice\t28');
        expect(payload?.imagePaths).toEqual(['D:/clip/image.png']);
        expect(payload?.fragments).toEqual([
            { type: 'text', text: 'Name\tAge\nAlice\t28' },
            { type: 'image', path: 'D:/clip/image.png' },
        ]);
    });

    it('user gets the exact whitespace they pasted', async () => {
        mockTauriCommand('read_clipboard_payload', () => {
            throw new Error('clipboard busy');
        });

        const payload = await clipboardService.readExplicitPastePayload(
            createClipboardData({
                'text/plain': '  keep me  ',
            })
        );

        expect(payload?.text).toBe('  keep me  ');
        expect(payload?.fragments).toEqual([{ type: 'text', text: '  keep me  ' }]);
    });

    it('user gets files from the browser paste when the native clipboard read fails', async () => {
        mockTauriCommand('read_clipboard_payload', () => {
            throw new Error('clipboard busy');
        });
        const imageFile = new File([new Uint8Array([1, 2, 3])], 'pasted.png', {
            type: 'image/png',
        });

        const payload = await clipboardService.readExplicitPastePayload(
            createClipboardDataWithFiles(
                {
                    'text/plain': 'caption',
                    'text/html': '<p>caption</p><img src="blob:https://example.com/1">',
                },
                [imageFile],
                [{ kind: 'file', getAsFile: () => imageFile }]
            )
        );

        const path = payload!.imagePaths[0]!;
        expect(files.get(path)).toEqual(new Uint8Array([1, 2, 3]));
        expect(
            database.prepare('SELECT original_name, origin_path, type FROM attachments').all()
        ).toEqual([
            { original_name: 'pasted.png', origin_path: 'clipboard:pasted.png', type: 'image' },
        ]);
        expect(payload?.fragments).toEqual([
            { type: 'text', text: 'caption' },
            { type: 'image', path },
        ]);
    });

    it('user gets fragments for a paste that only contained files', async () => {
        mockTauriCommand('read_clipboard_payload', () => {
            throw new Error('clipboard busy');
        });
        const file = new File([new Uint8Array([1, 2, 3])], 'report.pdf', {
            type: 'application/pdf',
        });

        const payload = await clipboardService.readExplicitPastePayload(
            createClipboardDataWithFiles({}, [file], [{ kind: 'file', getAsFile: () => file }])
        );

        expect(payload?.text).toBeNull();
        const path = payload!.filePaths[0]!;
        expect(files.get(path)).toEqual(new Uint8Array([1, 2, 3]));
        expect(
            database.prepare('SELECT original_name, origin_path, type FROM attachments').all()
        ).toEqual([
            { original_name: 'report.pdf', origin_path: 'clipboard:report.pdf', type: 'file' },
        ]);
        expect(payload?.fragments).toEqual([{ type: 'file', path }]);
    });
});

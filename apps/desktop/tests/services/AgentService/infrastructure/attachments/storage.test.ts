import { createHash } from 'node:crypto';

import { mockTauriCommand } from '@tests/utils/tauri';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import {
    createAttachment,
    createPersistedAttachmentFromData,
    hydratePersistedAttachments,
    persistPreparedAttachment,
    prepareAttachmentForPersistence,
} from '@/services/AgentService/infrastructure/attachments/storage';

import {
    closeTestDatabases,
    openMigratedDatabase,
    routeQueriesTo,
} from '../../../../database/sqliteHarness';

const system = vi.hoisted(() => ({
    files: new Map<string, Uint8Array>(),
    directories: new Set<string>(),
}));

vi.mock('@tauri-apps/api/core', async (importOriginal) => ({
    ...(await importOriginal<typeof import('@tauri-apps/api/core')>()),
    convertFileSrc: (path: string) => `asset://${path}`,
}));
vi.mock('@tauri-apps/api/path', () => ({
    join: (...parts: string[]) => Promise.resolve(parts.join('/')),
}));
vi.mock('@tauri-apps/plugin-fs', () => ({
    mkdir: async (path: string) => {
        system.directories.add(path);
    },
    exists: async (path: string) => system.files.has(path) || system.directories.has(path),
    stat: async (path: string) => {
        if (system.directories.has(path)) return { isDirectory: true, isFile: false, size: 0 };
        const bytes = system.files.get(path);
        if (!bytes) throw new Error('source unavailable');
        return { isDirectory: false, isFile: true, size: bytes.byteLength };
    },
    writeFile: async (path: string, bytes: Uint8Array) => {
        system.files.set(path, bytes.slice());
    },
}));
vi.mock('tauri-plugin-fs-pro-api', () => ({
    fullName: async (path: string) => path.split(/[\\/]/).pop() ?? '',
    icon: async () => '/icons/file.png',
    size: async (path: string) => system.files.get(path)?.byteLength ?? 0,
}));

let database: ReturnType<typeof openMigratedDatabase>;
const sample = new Uint8Array([1, 2, 3, 4]);
const digest = (bytes: Uint8Array) => createHash('sha256').update(bytes).digest('hex');
const targetPath = (type: string, hash: string) =>
    `/cache/attachments/${type === 'image' ? 'images' : 'files'}/${hash.slice(0, 3)}/${hash}`;

beforeEach(() => {
    system.files.clear();
    system.directories.clear();
    database = openMigratedDatabase();
    routeQueriesTo(database);
    mockTauriCommand('get_app_directory_path', '/cache');
    mockTauriCommand('storage_hold', 'fixture-activity');
    mockTauriCommand('storage_release', undefined);
    mockTauriCommand('storage_publish_attachment', (payload: unknown) => {
        const { attachmentType, sourcePath, expectedHash } = payload as {
            attachmentType: string;
            sourcePath: string;
            expectedHash?: string;
        };
        const bytes = system.files.get(sourcePath);
        if (!bytes) throw new Error('source unavailable');
        const hash = digest(bytes);
        if (expectedHash && hash !== expectedHash) throw new Error('storage_corrupt_attachment');
        const path = targetPath(attachmentType, hash);
        const existing = system.files.get(path);
        if (existing && digest(existing) !== hash) throw new Error('storage_corrupt_attachment');
        if (!existing) system.files.set(path, bytes.slice());
        if (sourcePath.includes('/.staging/')) system.files.delete(sourcePath);
        return { hash, path, size: bytes.byteLength };
    });
    vi.stubGlobal(
        'fetch',
        vi.fn(async (url: string) => {
            const bytes = system.files.get(String(url).slice('asset://'.length));
            return bytes
                ? new Response(new Uint8Array(bytes).buffer)
                : new Response(null, { status: 404, statusText: 'Not Found' });
        })
    );
});

afterEach(() => {
    closeTestDatabases();
    vi.unstubAllGlobals();
});

async function draft(type: 'image' | 'file' = 'file', path = '/original/report.pdf') {
    system.files.set(path, sample.slice());
    return createAttachment(type, path);
}

function records() {
    return database.prepare('SELECT * FROM attachments ORDER BY id').all();
}

describe('given a file is attached before submission', () => {
    it('user sees source metadata and no persistent copy before sending', async () => {
        const index = await draft();
        expect(index).toMatchObject({
            name: 'report.pdf',
            size: 4,
            originPath: '/original/report.pdf',
        });
        expect(index.attachmentId).toBeUndefined();
        expect(records()).toEqual([]);
        expect([...system.files.keys()]).toEqual(['/original/report.pdf']);
    });

    it('user sees a case-insensitive image MIME type and an image preview', async () => {
        const index = await draft('image', '/original/photo.JPG');
        expect(index.mimeType).toBe('image/jpeg');
        expect(index.preview).toBe('asset:///original/photo.JPG');
    });

    it('user attaches a directory by reference without copying its contents', async () => {
        system.directories.add('/documents');
        const index = await createAttachment('file', '/documents');
        await persistPreparedAttachment(index);
        expect(index.path).toBe('/documents');
        expect(index.mimeType).toBe('application/x-directory');
        expect(records()).toHaveLength(1);
        expect([...system.files]).toEqual([]);
    });
});

describe('given an attachment is sent', () => {
    it('user reopens the captured content even after changing the external source', async () => {
        const index = await draft();
        await persistPreparedAttachment(index);
        system.files.set('/original/report.pdf', new Uint8Array([9, 9]));
        expect(system.files.get(index.path)).toEqual(sample);
        expect(records()).toHaveLength(1);
        expect(index.attachmentId).toBeGreaterThan(0);
        expect(index.hash).toBe(digest(sample));
    });

    it('user resends the same content without another record or modifying the saved bytes', async () => {
        const first = await draft();
        await persistPreparedAttachment(first);
        const savedBytes = system.files.get(first.path);
        const second = await draft();
        await persistPreparedAttachment(second);
        expect(second.attachmentId).toBe(first.attachmentId);
        expect(system.files.get(first.path)).toBe(savedBytes);
        expect(records()).toHaveLength(1);
    });

    it('user gets one captured snapshot when preparing before a transaction', async () => {
        const index = await draft();
        await prepareAttachmentForPersistence(index);
        system.files.set('/original/report.pdf', new Uint8Array([8, 8]));
        await persistPreparedAttachment(index);
        expect(system.files.get(index.path)).toEqual(sample);
        expect(records()).toHaveLength(1);
    });

    it('user gets an unavailable-file error instead of an empty saved attachment', async () => {
        const index = await draft();
        system.files.delete(index.path);
        await expect(persistPreparedAttachment(index)).rejects.toThrow('source unavailable');
        expect(records()).toEqual([]);
    });
});

class NormalizingCanvas {
    constructor(
        public width: number,
        public height: number
    ) {}
    getContext() {
        return { save() {}, restore() {}, fillRect() {}, drawImage() {}, fillStyle: '' };
    }
    async convertToBlob({ type }: { type: string }) {
        return new Blob([new Uint8Array([9, 9])], {
            type: type === 'image/png' ? 'unsupported' : type,
        });
    }
}

describe('given an oversized image or tool media is supplied', () => {
    it('user stores the existing normalized image policy without changing original bytes', async () => {
        vi.stubGlobal('createImageBitmap', async () => ({ width: 4000, height: 2000, close() {} }));
        vi.stubGlobal('OffscreenCanvas', NormalizingCanvas);
        const index = await draft('image', '/original/photo.png');
        await persistPreparedAttachment(index);
        expect(index.mimeType).toBe('image/jpeg');
        expect(index.size).toBe(2);
        expect(system.files.get(index.path)).toEqual(new Uint8Array([9, 9]));
        expect(system.files.get('/original/photo.png')).toEqual(sample);
    });

    it('user preserves this media name and origin when its bytes were already stored', async () => {
        await createPersistedAttachmentFromData({
            type: 'image',
            name: 'first.png',
            originPath: 'tool://first',
            data: sample,
        });
        const second = await createPersistedAttachmentFromData({
            type: 'image',
            name: 'second.png',
            originPath: 'tool://second',
            data: sample,
        });
        expect(second).toMatchObject({ name: 'second.png', originPath: 'tool://second', size: 4 });
        expect(records()).toHaveLength(1);
        expect(system.files.get(second.path)).toEqual(sample);
    });

    it('user cannot silently reuse a corrupted saved file', async () => {
        const hash = digest(sample);
        const path = targetPath('image', hash);
        system.files.set(path, new Uint8Array([8, 8]));
        await expect(
            createPersistedAttachmentFromData({
                type: 'image',
                name: 'image.png',
                originPath: 'tool://image',
                data: sample,
            })
        ).rejects.toThrow('storage_corrupt_attachment');
        expect(system.files.get(path)).toEqual(new Uint8Array([8, 8]));
        expect(records()).toEqual([]);
    });
});

describe('given a stored conversation is reopened', () => {
    it('user gets the same attachment path and per-message origin restored', async () => {
        const index = await draft('image', '/original/photo.png');
        const record = await persistPreparedAttachment(index);
        const restored = await hydratePersistedAttachments([
            {
                ...record,
                message_id: 1,
                sort_order: 0,
                tool_call_id: null,
                tool_kind: null,
                origin_path: '/per-message/original.png',
            },
        ]);
        expect(restored[0]).toMatchObject({
            attachmentId: record.id,
            path: index.path,
            originPath: '/per-message/original.png',
        });
        expect(system.files.get(restored[0]!.path)).toEqual(sample);
    });

    it('user keeps an empty attachment list when the message contained no media', async () => {
        expect(await hydratePersistedAttachments([])).toEqual([]);
    });
});

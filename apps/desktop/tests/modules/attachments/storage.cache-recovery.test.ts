// Copyright (c) 2026. Qian Cheng. Licensed under GPL v3

import { existsSync, rmSync } from 'node:fs';
import {
    copyFile as copyFileOnDisk,
    mkdir as createDirectory,
    open as openFile,
    readFile as readFileOnDisk,
    stat as statOnDisk,
    utimes as setFileTimes,
    writeFile as writeFileOnDisk,
} from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { basename, join as joinPath } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

import {
    closeTestDatabases,
    openMigratedDatabase,
    routeQueriesTo,
} from '@tests/database/sqliteHarness';
import { mockTauriCommand } from '@tests/utils/tauri';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { readAttachmentBuffer } from '@/modules/attachments/content.io';
import { createAttachment, ensurePersistedAttachmentIndex } from '@/modules/attachments/storage.io';
import type { AttachmentIndex } from '@/modules/attachments/types';

/** Root of the temporary app cache and the user files that feed it. */
let workspace = '';
let cacheRoot = '';
let sourceRoot = '';

vi.mock('@/platform/files', () => ({
    convertFileSrc: (path: string) => pathToFileURL(path).href,
    copyFile: copyFileOnDisk,
    exists: async (path: string) => existsSync(path),
    join: async (...parts: string[]) => parts.join('/'),
    mkdir: createDirectory,
    open: openFile,
    stat: async (path: string) => {
        const info = await statOnDisk(path);
        return { isFile: info.isFile(), isDirectory: info.isDirectory(), size: info.size };
    },
    writeFile: writeFileOnDisk,
    fullName: async (path: string) => basename(path),
    icon: async () => '/icons/placeholder.png',
    size: async (path: string) => (await statOnDisk(path)).size,
}));

// Image normalization needs a canvas; the limits it enforces are covered elsewhere.
vi.mock('@/modules/attachments/image.io', () => ({
    normalizeImageBytes: async (input: { bytes: Uint8Array; mimeType: string }) => ({
        ...input,
        resized: false,
    }),
}));

/** Serve `asset://` reads from the real file system, like the native asset protocol does. */
async function fetchFromDisk(input: unknown) {
    try {
        const bytes = await readFileOnDisk(fileURLToPath(String(input)));
        return {
            ok: true,
            statusText: 'OK',
            arrayBuffer: async () =>
                bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength),
        };
    } catch {
        return { ok: false, statusText: 'Not Found' };
    }
}

async function writeSourceFile(name: string, bytes: Uint8Array): Promise<string> {
    const path = joinPath(sourceRoot, name);
    await writeFileOnDisk(path, bytes);
    return path;
}

/** Attach a file and persist it, so both the cached copy and the database row exist. */
async function attachAndPersist(type: 'image' | 'file', sourcePath: string) {
    const draft: AttachmentIndex = await createAttachment(type, sourcePath);
    const record = await ensurePersistedAttachmentIndex(draft);
    expect(existsSync(draft.path)).toBe(true);
    return { draft, record };
}

function attachmentRowCount(): number {
    return (
        database.prepare('SELECT COUNT(*) AS total FROM attachments').get() as { total: number }
    ).total;
}

let database: ReturnType<typeof openMigratedDatabase>;

beforeEach(async () => {
    workspace = joinPath(
        tmpdir(),
        `touchai-attachments-${Date.now()}-${Math.random().toString(16).slice(2)}`
    );
    cacheRoot = joinPath(workspace, 'cache');
    sourceRoot = joinPath(workspace, 'source');
    await createDirectory(cacheRoot, { recursive: true });
    await createDirectory(sourceRoot, { recursive: true });
    database = openMigratedDatabase();
    routeQueriesTo(database);
    mockTauriCommand('get_app_directory_path', cacheRoot);
    vi.stubGlobal('fetch', vi.fn(fetchFromDisk));
});

afterEach(() => {
    vi.unstubAllGlobals();
    closeTestDatabases();
    rmSync(workspace, { recursive: true, force: true });
});

describe('user resends a message after the attachment cache was cleaned', () => {
    it('user gets the cached copy restored from the original file', async () => {
        const sourcePath = await writeSourceFile('report.pdf', new Uint8Array([1, 2, 3, 4]));
        const { draft, record } = await attachAndPersist('file', sourcePath);
        // A cleanup tool or the OS removed the derived copy; the row still points at it.
        rmSync(draft.path);
        expect(existsSync(draft.path)).toBe(false);

        await ensurePersistedAttachmentIndex(draft);

        expect(existsSync(draft.path)).toBe(true);
        expect(draft.attachmentId).toBe(record.id);
        expect(attachmentRowCount()).toBe(1);
        const bytes = new Uint8Array(await readAttachmentBuffer(draft.path));
        expect([...bytes]).toEqual([1, 2, 3, 4]);
    });

    it('user gets a cleaned image copy restored as well', async () => {
        const sourcePath = await writeSourceFile('photo.png', new Uint8Array([9, 8, 7]));
        const { draft } = await attachAndPersist('image', sourcePath);
        expect(draft.path).toContain('/cache/attachments/images/');
        rmSync(draft.path);

        await ensurePersistedAttachmentIndex(draft);

        expect(existsSync(draft.path)).toBe(true);
        const bytes = new Uint8Array(await readAttachmentBuffer(draft.path));
        expect([...bytes]).toEqual([9, 8, 7]);
    });
});

describe('user resends a message while the attachment cache is intact', () => {
    it('user gets the cached copy reused without a second write', async () => {
        const sourcePath = await writeSourceFile('notes.txt', new Uint8Array([5, 5, 5]));
        const { draft } = await attachAndPersist('file', sourcePath);
        const past = new Date('2026-01-01T00:00:00Z');
        await setFileTimes(draft.path, past, past);
        const before = (await statOnDisk(draft.path)).mtimeMs;

        await ensurePersistedAttachmentIndex(draft);

        expect((await statOnDisk(draft.path)).mtimeMs).toBe(before);
        expect(attachmentRowCount()).toBe(1);
    });
});

describe('user resends a message after the cache and the original file are gone', () => {
    it('user gets the send reported as failed instead of a path to nothing', async () => {
        const sourcePath = await writeSourceFile('gone.pdf', new Uint8Array([4, 4, 4]));
        const { draft, record } = await attachAndPersist('file', sourcePath);
        rmSync(draft.path);
        rmSync(sourcePath);

        await expect(ensurePersistedAttachmentIndex(draft)).rejects.toThrow();

        // No half-rebuilt state: the row and the reference stay as they were.
        expect(attachmentRowCount()).toBe(1);
        expect(draft.attachmentId).toBe(record.id);
    });
});

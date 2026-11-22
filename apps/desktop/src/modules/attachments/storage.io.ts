/*
 * Copyright (c) 2026. Qian Cheng. Licensed under GPL v3
 */

import { type DatabaseExecutor, db } from '@database';
import {
    createAttachmentRecord,
    findAttachmentByHash,
    type MessageAttachmentRow,
} from '@database/queries';
import type { AttachmentEntity } from '@database/types';

import { convertFileSrc, copyFile, exists, join, mkdir, stat, writeFile } from '@/platform/files';
import {
    fullName as getFileName,
    icon as getFileIcon,
    size as getFileSize,
} from '@/platform/files';
import { native } from '@/platform/native';

import { bytesToArrayBuffer, readAttachmentBuffer } from './content.io';
import { normalizeImageBytes } from './image.io';
import { type AttachmentIndex, DIRECTORY_MIME_TYPE } from './types';

const imageMimeMap: Record<string, string> = {
    jpg: 'image/jpeg',
    jpeg: 'image/jpeg',
    png: 'image/png',
    gif: 'image/gif',
    webp: 'image/webp',
    bmp: 'image/bmp',
    svg: 'image/svg+xml',
    avif: 'image/avif',
};

/** Attachment persistence only needs these transaction-scoped record operations. */
export interface AttachmentRecordWriter {
    findByHash(hash: string): Promise<AttachmentEntity | null>;
    create(input: Omit<AttachmentEntity, 'id' | 'created_at'>): Promise<AttachmentEntity>;
}

function normalizeExtension(extension: string | null | undefined): string {
    return (extension || '').replace('.', '').trim().toLowerCase();
}

async function resolveMimeType(
    type: AttachmentIndex['type'],
    path: string
): Promise<string | undefined> {
    if (type !== 'image') return undefined;
    const extension = normalizeExtension(path.split('.').pop());
    return imageMimeMap[extension] || 'image/png';
}

async function buildPreview(
    type: AttachmentIndex['type'],
    path: string
): Promise<string | undefined> {
    if (type === 'image') {
        return convertFileSrc(path);
    }

    try {
        const iconPath = await getFileIcon(path, { size: 256 });
        return convertFileSrc(iconPath);
    } catch {
        // Icon lookup is platform-specific; a missing preview must not block the attachment.
        return undefined;
    }
}

async function computeAttachmentHash(path: string): Promise<string> {
    const response = await fetch(convertFileSrc(path));
    if (!response.ok) {
        throw new Error(`Failed to read attachment: ${response.statusText}`);
    }

    const buffer = await response.arrayBuffer();
    const digest = await crypto.subtle.digest('SHA-256', buffer);
    return Array.from(new Uint8Array(digest), (byte) => byte.toString(16).padStart(2, '0')).join(
        ''
    );
}

async function computeAttachmentHashFromBytes(bytes: Uint8Array): Promise<string> {
    const digest = await crypto.subtle.digest('SHA-256', bytesToArrayBuffer(bytes));
    return Array.from(new Uint8Array(digest), (byte) => byte.toString(16).padStart(2, '0')).join(
        ''
    );
}

let cachedCacheDirectory: string | null = null;

async function ensureCacheDirectory(): Promise<string> {
    if (cachedCacheDirectory) {
        return cachedCacheDirectory;
    }

    const cachePath = await native.paths.getAppDirectoryPath('CACHE');
    const attachmentsPath = await join(cachePath, 'attachments');
    await mkdir(attachmentsPath, { recursive: true });
    cachedCacheDirectory = attachmentsPath;
    return attachmentsPath;
}

function getAttachmentBucket(type: AttachmentIndex['type']): 'images' | 'files' {
    return type === 'image' ? 'images' : 'files';
}

/**
 * 按固定规则推导附件缓存路径，避免把纯派生值冗余存进数据库。
 *
 * 目录结构固定为：
 * - cache/attachments/images/<hash前三位>/<hash>
 * - cache/attachments/files/<hash前三位>/<hash>
 *
 * @param type 附件类型。
 * @param hash 附件内容哈希。
 * @returns 缓存副本的绝对路径。
 */
async function attachmentShardDirectory(
    type: AttachmentIndex['type'],
    hash: string
): Promise<string> {
    const cacheDir = await ensureCacheDirectory();
    const bucketDir = await join(cacheDir, getAttachmentBucket(type));
    return join(bucketDir, hash.slice(0, 3));
}

/**
 * 推导缓存副本的绝对路径，但不创建目录：存在性检查不该顺手落盘。
 *
 * @param type 附件类型。
 * @param hash 附件内容哈希。
 * @returns 缓存副本的绝对路径。
 */
async function attachmentCachePath(type: AttachmentIndex['type'], hash: string): Promise<string> {
    return join(await attachmentShardDirectory(type, hash), hash);
}

async function buildAttachmentStoragePath(
    type: AttachmentIndex['type'],
    hash: string
): Promise<string> {
    const shardDir = await attachmentShardDirectory(type, hash);
    await mkdir(shardDir, { recursive: true });
    return join(shardDir, hash);
}

/**
 * 附件落盘（hash + 文件复制）的结果。
 *
 * 必须先于写事务完成：放在事务内会把持锁时长抬到秒级，
 * 并发写库时直接撞满 5s 的 busy_timeout。
 */
type PreparedAttachment = {
    hash: string;
    name: string;
    mimeType: string | null;
    size: number | null;
};

/** 只做文件 I/O，不碰数据库：供事务外预计算。 */
async function prepareAttachment(
    type: AttachmentIndex['type'],
    path: string
): Promise<PreparedAttachment> {
    const info = await stat(path);
    const name = await getFileName(path);

    if (info.isDirectory) {
        return {
            hash: await computeAttachmentHashFromBytes(
                new TextEncoder().encode(`directory:${path}`)
            ),
            name,
            mimeType: DIRECTORY_MIME_TYPE,
            size: null,
        };
    }

    const [mimeType, size] = await Promise.all([resolveMimeType(type, path), getFileSize(path)]);

    if (type === 'image') {
        const buffer = await readAttachmentBuffer(path);
        const normalized = await normalizeImageBytes({
            bytes: new Uint8Array(buffer),
            mimeType: mimeType ?? 'image/png',
        });
        const hash = await computeAttachmentHashFromBytes(normalized.bytes);
        const targetPath = await buildAttachmentStoragePath(type, hash);
        await writeFile(targetPath, normalized.bytes);
        return {
            hash,
            name,
            mimeType: normalized.mimeType,
            size: normalized.bytes.byteLength,
        };
    }

    const hash = await computeAttachmentHash(path);
    const targetPath = await buildAttachmentStoragePath(type, hash);
    await copyFile(path, targetPath);

    return { hash, name, mimeType: mimeType ?? null, size };
}

/**
 * 已持久化附件只有在缓存副本仍在时才能直接复用身份。
 *
 * 缓存目录会被系统或清理工具删除，而数据库行仍指向那条派生路径；
 * 只看行会让草稿带着一个不存在的路径继续往前走。
 */
async function canReusePersistedAttachment(attachment: AttachmentIndex): Promise<boolean> {
    if (attachment.attachmentId === undefined || !attachment.hash) {
        return false;
    }

    // 目录记录直接引用原始路径，没有派生缓存副本。
    if (attachment.mimeType === DIRECTORY_MIME_TYPE) {
        return true;
    }

    return exists(await attachmentCachePath(attachment.type, attachment.hash));
}

/** 缓存副本缺失时只能回到原始文件：草稿的 path 已经指向那条缺失的派生路径。 */
function persistenceSourcePath(attachment: AttachmentIndex): string {
    return attachment.attachmentId !== undefined && attachment.hash
        ? attachment.originPath
        : attachment.path;
}

async function ensureAttachmentRecord(
    type: AttachmentIndex['type'],
    path: string,
    originPath: string,
    writer: AttachmentRecordWriter,
    prepared?: PreparedAttachment
): Promise<AttachmentEntity> {
    const { hash, name, mimeType, size } = prepared ?? (await prepareAttachment(type, path));

    const existing = await writer.findByHash(hash);
    if (existing) {
        return existing;
    }

    try {
        return await writer.create({
            hash,
            type,
            original_name: name,
            origin_path: originPath,
            mime_type: mimeType,
            size,
        });
    } catch (error) {
        const duplicated = await writer.findByHash(hash);
        if (duplicated) {
            return duplicated;
        }

        throw error;
    }
}

async function ensureAttachmentRecordFromBytes(
    options: {
        type: AttachmentIndex['type'];
        name: string;
        originPath: string;
        mimeType?: string;
        size?: number;
        data: Uint8Array;
    },
    database: DatabaseExecutor = db
): Promise<AttachmentEntity> {
    const prepared =
        options.type === 'image'
            ? await normalizeImageBytes({
                  bytes: options.data,
                  mimeType: options.mimeType ?? 'image/png',
              })
            : { bytes: options.data, mimeType: options.mimeType, resized: false };
    const hash = await computeAttachmentHashFromBytes(prepared.bytes);
    const targetPath = await buildAttachmentStoragePath(options.type, hash);

    if (!(await exists(targetPath))) {
        await writeFile(targetPath, prepared.bytes);
    }

    const existing = await findAttachmentByHash(hash, database);
    if (existing) {
        return existing;
    }

    try {
        return await createAttachmentRecord(
            {
                hash,
                type: options.type,
                original_name: options.name,
                origin_path: options.originPath,
                mime_type: prepared.mimeType ?? null,
                size: prepared.bytes.byteLength,
            },
            database
        );
    } catch (error) {
        const duplicated = await findAttachmentByHash(hash, database);
        if (duplicated) {
            return duplicated;
        }

        throw error;
    }
}

async function toAttachmentIndex(
    attachment: AttachmentEntity,
    overrides: {
        originPath?: string;
        name?: string;
        size?: number;
        mimeType?: string;
    } = {}
): Promise<AttachmentIndex> {
    const originPath = overrides.originPath ?? attachment.origin_path;
    const isDirectory = attachment.mime_type === DIRECTORY_MIME_TYPE;
    const storagePath = isDirectory
        ? originPath
        : await buildAttachmentStoragePath(attachment.type, attachment.hash);
    return {
        id: crypto.randomUUID(),
        attachmentId: attachment.id,
        hash: attachment.hash,
        type: attachment.type,
        path: storagePath,
        originPath,
        name: overrides.name ?? attachment.original_name,
        size: overrides.size ?? attachment.size ?? undefined,
        preview: await buildPreview(attachment.type, storagePath),
        mimeType: overrides.mimeType ?? attachment.mime_type ?? undefined,
        supportStatus: 'supported',
    };
}

/**
 * 基于原始文件创建草稿附件引用。
 *
 * 草稿阶段只保留发送前展示所需的最小元数据，不立即复制到缓存目录，
 * 避免用户临时粘贴但最终未发送的附件也落入长期缓存。
 *
 * @param type 附件类型。
 * @param path 原始文件路径。
 * @returns 指向原始文件的草稿附件引用。
 */
export async function createAttachment(
    type: 'image' | 'file',
    path: string
): Promise<AttachmentIndex> {
    const info = await stat(path);
    const [name, mimeType, preview, size] = await Promise.all([
        getFileName(path),
        resolveMimeType(type, path),
        buildPreview(type, path),
        info.isDirectory ? Promise.resolve(undefined) : getFileSize(path),
    ]);

    return {
        id: crypto.randomUUID(),
        type,
        path,
        originPath: path,
        name,
        size,
        preview,
        mimeType: info.isDirectory ? DIRECTORY_MIME_TYPE : mimeType,
        supportStatus: 'supported',
    };
}

/**
 * 基于已有字节内容直接创建并持久化附件。
 *
 * 主要用于工具结果里的媒体内容：它们没有“原始本地文件”，
 * 但仍应复用统一附件缓存、去重和后续 transport 逻辑。
 */
export async function createPersistedAttachmentFromData(
    options: {
        type: 'image' | 'file';
        name: string;
        originPath: string;
        mimeType?: string;
        size?: number;
        data: Uint8Array;
    },
    database: DatabaseExecutor = db
): Promise<AttachmentIndex> {
    const persisted = await ensureAttachmentRecordFromBytes(options, database);
    return toAttachmentIndex(persisted, {
        // 字节型附件可能命中去重记录，但当前调用方的来源路径/名称
        // 仍然属于这一次消息语义，不能被旧记录回灌覆盖。
        originPath: options.originPath,
        name: options.name,
        size: persisted.size ?? options.size ?? options.data.byteLength,
        mimeType: persisted.mime_type ?? options.mimeType ?? undefined,
    });
}

/**
 * 将数据库附件记录恢复成前端附件引用。
 *
 * @param attachments 持久化层返回的附件行。
 * @returns 可直接挂到消息上的附件列表。
 */
export async function hydratePersistedAttachments(
    attachments: MessageAttachmentRow[]
): Promise<AttachmentIndex[]> {
    return Promise.all(
        attachments.map((attachment) =>
            toAttachmentIndex({
                id: attachment.id,
                hash: attachment.hash,
                type: attachment.type,
                original_name: attachment.original_name,
                origin_path: attachment.origin_path,
                mime_type: attachment.mime_type,
                size: attachment.size,
                created_at: attachment.created_at,
            })
        )
    );
}

/**
 * Restore one attachment from its content hash.
 *
 * Pending queue payloads store hashes instead of local attachment row ids, so
 * restoring a backup never has to rewrite queued JSON.
 */
export async function hydratePersistedAttachmentByHash(
    hash: string,
    overrides: {
        originPath?: string;
        name?: string;
    } = {},
    database: DatabaseExecutor = db
): Promise<AttachmentIndex | null> {
    const attachment = await findAttachmentByHash(hash, database);
    if (!attachment) {
        return null;
    }

    return toAttachmentIndex(attachment, overrides);
}

/**
 * 确保持久化层可识别当前附件引用。
 *
 * 草稿附件在真正发送前不会写入缓存；只有请求开始持久化时，
 * 才会复制到 `cache/attachments` 并创建数据库记录。
 * 历史恢复的附件则已经带上 `attachmentId/hash`，可直接复用。
 *
 * @param attachment 前端附件引用。
 * @returns 可写入附件缓存表的附件记录。
 */
export async function ensurePersistedAttachmentIndex(
    attachment: AttachmentIndex,
    database: DatabaseExecutor = db
): Promise<AttachmentEntity> {
    return persistPreparedAttachment(attachment, database);
}

/**
 * 事务外预计算：只做 hash 与文件复制，不碰数据库。
 *
 * 调用方在开启写事务前先跑这一步，事务内就只剩几条 SQL。
 */
export async function prepareAttachmentForPersistence(attachment: AttachmentIndex): Promise<void> {
    if (await canReusePersistedAttachment(attachment)) {
        return;
    }

    preparedAttachments.set(
        attachment,
        await prepareAttachment(attachment.type, persistenceSourcePath(attachment))
    );
}

/** 事务外预计算结果，按附件实例缓存。 */
const preparedAttachments = new WeakMap<AttachmentIndex, PreparedAttachment>();

/** 写入附件记录；若未预计算则退化为就地计算。 */
export async function persistPreparedAttachment(
    attachment: AttachmentIndex,
    database: DatabaseExecutor = db
): Promise<AttachmentEntity> {
    return persistPreparedAttachmentWithWriter(attachment, {
        findByHash: (hash) => findAttachmentByHash(hash, database),
        create: (input) => createAttachmentRecord(input, database),
    });
}

export async function persistPreparedAttachmentWithWriter(
    attachment: AttachmentIndex,
    writer: AttachmentRecordWriter
): Promise<AttachmentEntity> {
    const existingId = attachment.attachmentId;
    const existingHash = attachment.hash;
    if (
        existingId !== undefined &&
        existingHash &&
        (await canReusePersistedAttachment(attachment))
    ) {
        return {
            id: existingId,
            hash: existingHash,
            type: attachment.type,
            original_name: attachment.name,
            origin_path: attachment.originPath,
            mime_type: attachment.mimeType ?? null,
            size: attachment.size ?? null,
            created_at: new Date().toISOString(),
        };
    }

    const persisted = await ensureAttachmentRecord(
        attachment.type,
        persistenceSourcePath(attachment),
        attachment.originPath,
        writer,
        preparedAttachments.get(attachment)
    );
    preparedAttachments.delete(attachment);
    await syncAttachmentIndexFromRecord(attachment, persisted);

    return persisted;
}

/** 把数据库记录回写到调用方的附件引用上。 */
async function syncAttachmentIndexFromRecord(
    attachment: AttachmentIndex,
    persisted: AttachmentEntity
): Promise<void> {
    attachment.attachmentId = persisted.id;
    attachment.hash = persisted.hash;
    attachment.path =
        persisted.mime_type === DIRECTORY_MIME_TYPE
            ? persisted.origin_path
            : await buildAttachmentStoragePath(persisted.type, persisted.hash);
    attachment.name = persisted.original_name;
    attachment.size = persisted.size ?? undefined;
    attachment.mimeType = persisted.mime_type ?? undefined;
    attachment.preview = await buildPreview(persisted.type, attachment.path);
}

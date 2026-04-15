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
import { native } from '@services/NativeService';
import { convertFileSrc } from '@tauri-apps/api/core';
import { join } from '@tauri-apps/api/path';
import { copyFile, exists, mkdir, writeFile } from '@tauri-apps/plugin-fs';
import {
    fullName as getFileName,
    icon as getFileIcon,
    size as getFileSize,
} from 'tauri-plugin-fs-pro-api';

import type { AttachmentIndex } from './types';

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

    const iconPath = await getFileIcon(path, { size: 256 });
    return convertFileSrc(iconPath);
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
    const digest = await crypto.subtle.digest('SHA-256', bytes);
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
async function buildAttachmentStoragePath(
    type: AttachmentIndex['type'],
    hash: string
): Promise<string> {
    const cacheDir = await ensureCacheDirectory();
    const bucketDir = await join(cacheDir, getAttachmentBucket(type));
    const shardDir = await join(bucketDir, hash.slice(0, 3));
    await mkdir(shardDir, { recursive: true });
    return join(shardDir, hash);
}

async function ensureAttachmentRecord(
    type: AttachmentIndex['type'],
    path: string,
    originPath: string,
    database: DatabaseExecutor = db
): Promise<AttachmentEntity> {
    const [hash, name, mimeType, size] = await Promise.all([
        computeAttachmentHash(path),
        getFileName(path),
        resolveMimeType(type, path),
        getFileSize(path),
    ]);

    const existing = await findAttachmentByHash(hash, database);
    if (existing) {
        return existing;
    }

    const targetPath = await buildAttachmentStoragePath(type, hash);
    await copyFile(path, targetPath);

    try {
        return await createAttachmentRecord(
            {
                hash,
                type,
                original_name: name,
                origin_path: originPath,
                mime_type: mimeType ?? null,
                size,
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
    const hash = await computeAttachmentHashFromBytes(options.data);
    const targetPath = await buildAttachmentStoragePath(options.type, hash);

    if (!(await exists(targetPath))) {
        await writeFile(targetPath, options.data);
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
                mime_type: options.mimeType ?? null,
                size: options.size ?? options.data.byteLength,
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
    const storagePath = await buildAttachmentStoragePath(attachment.type, attachment.hash);
    return {
        id: crypto.randomUUID(),
        attachmentId: attachment.id,
        hash: attachment.hash,
        type: attachment.type,
        path: storagePath,
        originPath: overrides.originPath ?? attachment.origin_path,
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
    const [name, mimeType, size, preview] = await Promise.all([
        getFileName(path),
        resolveMimeType(type, path),
        getFileSize(path),
        buildPreview(type, path),
    ]);

    return {
        id: crypto.randomUUID(),
        type,
        path,
        originPath: path,
        name,
        size,
        preview,
        mimeType,
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
        size: options.size ?? options.data.byteLength,
        mimeType: options.mimeType ?? persisted.mime_type ?? undefined,
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
 * 确保持久化层可识别当前附件引用。
 *
 * 草稿附件在真正发送前不会写入缓存；只有请求开始持久化时，
 * 才会复制到 `cache/attachments` 并创建数据库记录。
 * 历史恢复的附件则已经带上 `attachmentId/hash`，可直接复用。
 *
 * @param attachment 前端附件引用。
 * @returns 可写入 message_attachments 的附件记录。
 */
export async function ensurePersistedAttachmentIndex(
    attachment: AttachmentIndex,
    database: DatabaseExecutor = db
): Promise<AttachmentEntity> {
    if (attachment.attachmentId && attachment.hash) {
        return {
            id: attachment.attachmentId,
            hash: attachment.hash,
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
        attachment.path,
        attachment.originPath,
        database
    );
    attachment.attachmentId = persisted.id;
    attachment.hash = persisted.hash;
    attachment.path = await buildAttachmentStoragePath(persisted.type, persisted.hash);
    attachment.name = persisted.original_name;
    attachment.size = persisted.size ?? undefined;
    attachment.mimeType = persisted.mime_type ?? undefined;
    attachment.preview = await buildPreview(persisted.type, attachment.path);

    return persisted;
}

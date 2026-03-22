/*
 * Copyright (c) 2026. Qian Cheng. Licensed under GPL v3
 */

import {
    createAttachmentRecord,
    findAttachmentByHash,
    type MessageAttachmentRow,
} from '@database/queries';
import type { AttachmentEntity } from '@database/types';
import { native } from '@services/NativeService';
import { convertFileSrc } from '@tauri-apps/api/core';
import { join } from '@tauri-apps/api/path';
import { copyFile, mkdir } from '@tauri-apps/plugin-fs';
import {
    fullName as getFileName,
    icon as getFileIcon,
    size as getFileSize,
} from 'tauri-plugin-fs-pro-api';

export type AttachmentSupportStatus = 'supported' | 'unsupported-image' | 'unsupported-file';

export interface Index {
    id: string;
    attachmentId?: number;
    hash?: string;
    type: 'image' | 'file';
    path: string;
    name: string;
    size?: number;
    preview?: string;
    mimeType?: string;
    supportStatus?: AttachmentSupportStatus;
}

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

async function resolveMimeType(type: Index['type'], path: string): Promise<string | undefined> {
    if (type !== 'image') return undefined;
    const extension = normalizeExtension(path.split('.').pop());
    return imageMimeMap[extension] || 'image/png';
}

function buildPreview(type: Index['type'], path: string): Promise<string | undefined> {
    if (type === 'image') {
        return Promise.resolve(convertFileSrc(path));
    }

    return getFileIcon(path, { size: 256 }).then((iconPath) => convertFileSrc(iconPath));
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

function getAttachmentBucket(type: Index['type']): 'images' | 'files' {
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
async function buildAttachmentStoragePath(type: Index['type'], hash: string): Promise<string> {
    const cacheDir = await ensureCacheDirectory();
    const bucketDir = await join(cacheDir, getAttachmentBucket(type));
    const shardDir = await join(bucketDir, hash.slice(0, 3));
    await mkdir(shardDir, { recursive: true });
    return join(shardDir, hash);
}

async function ensureAttachmentRecord(
    type: Index['type'],
    path: string
): Promise<AttachmentEntity> {
    const [hash, name, mimeType, size] = await Promise.all([
        computeAttachmentHash(path),
        getFileName(path),
        resolveMimeType(type, path),
        getFileSize(path),
    ]);

    // 基于文件哈希去重。
    const existing = await findAttachmentByHash(hash);
    if (existing) {
        return existing;
    }

    const targetPath = await buildAttachmentStoragePath(type, hash);

    // 附件进入会话前统一复制到应用缓存目录，持久化层与会话层都只引用缓存副本。
    await copyFile(path, targetPath);

    try {
        return await createAttachmentRecord({
            hash,
            type,
            original_name: name,
            mime_type: mimeType ?? null,
            size,
        });
    } catch (error) {
        // 并发导入相同文件时，唯一索引会把后写入者拦下；这里回查即可复用已落库记录。
        const duplicated = await findAttachmentByHash(hash);
        if (duplicated) {
            return duplicated;
        }

        throw error;
    }
}

async function toAttachmentIndex(attachment: AttachmentEntity): Promise<Index> {
    const storagePath = await buildAttachmentStoragePath(attachment.type, attachment.hash);
    return {
        id: `${Date.now()}-${Math.random().toString(36).substring(2, 5)}`,
        attachmentId: attachment.id,
        hash: attachment.hash,
        type: attachment.type,
        path: storagePath,
        name: attachment.original_name,
        size: attachment.size ?? undefined,
        preview: await buildPreview(attachment.type, storagePath),
        mimeType: attachment.mime_type ?? undefined,
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
export async function createAttachment(type: 'image' | 'file', path: string): Promise<Index> {
    const [name, mimeType, size, preview] = await Promise.all([
        getFileName(path),
        resolveMimeType(type, path),
        getFileSize(path),
        buildPreview(type, path),
    ]);

    return {
        id: `${Date.now()}-${Math.random().toString(36).substring(2, 5)}`,
        type,
        path,
        name,
        size,
        preview,
        mimeType,
        supportStatus: 'supported',
    };
}

/**
 * 将数据库附件记录恢复成前端附件引用。
 *
 * @param attachments 持久化层返回的附件行。
 * @returns 可直接挂到消息上的附件列表。
 */
export async function hydratePersistedAttachments(
    attachments: MessageAttachmentRow[]
): Promise<Index[]> {
    return Promise.all(
        attachments.map((attachment) =>
            toAttachmentIndex({
                id: attachment.id,
                hash: attachment.hash,
                type: attachment.type,
                original_name: attachment.original_name,
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
export async function ensurePersistedAttachmentIndex(attachment: Index): Promise<AttachmentEntity> {
    if (attachment.attachmentId && attachment.hash) {
        return {
            id: attachment.attachmentId,
            hash: attachment.hash,
            type: attachment.type,
            original_name: attachment.name,
            mime_type: attachment.mimeType ?? null,
            size: attachment.size ?? null,
            created_at: new Date().toISOString(),
        };
    }

    const persisted = await ensureAttachmentRecord(attachment.type, attachment.path);
    attachment.attachmentId = persisted.id;
    attachment.hash = persisted.hash;
    attachment.path = await buildAttachmentStoragePath(persisted.type, persisted.hash);
    attachment.name = persisted.original_name;
    attachment.size = persisted.size ?? undefined;
    attachment.mimeType = persisted.mime_type ?? undefined;
    attachment.preview = await buildPreview(persisted.type, attachment.path);

    return persisted;
}

/**
 * 根据文件类型和模型能力计算附件支持状态。
 *
 * @param fileType 附件类型（'image' | 'file'）。
 * @param capabilities 当前模型的能力标志。
 * @returns 'supported' | 'unsupported-image' | 'unsupported-file'。
 */
export function resolveAttachmentSupportStatus(
    fileType: 'image' | 'file',
    capabilities: { supportsImages: boolean; supportsFiles: boolean }
): AttachmentSupportStatus {
    if (fileType === 'image' && !capabilities.supportsImages) return 'unsupported-image';
    if (fileType === 'file' && !capabilities.supportsFiles) return 'unsupported-file';
    return 'supported';
}

export function isAttachmentSupported(attachment: Index): boolean {
    return (
        attachment.supportStatus !== 'unsupported-image' &&
        attachment.supportStatus !== 'unsupported-file'
    );
}

export function getAttachmentSupportMessage(attachment: Index): string | null {
    if (attachment.supportStatus === 'unsupported-image') {
        return '该模型不支持图片';
    }
    if (attachment.supportStatus === 'unsupported-file') {
        return '该模型不支持文件';
    }
    return null;
}

async function readAttachmentBuffer(path: string): Promise<ArrayBuffer> {
    const response = await fetch(convertFileSrc(path));
    if (!response.ok) {
        throw new Error(`Failed to read attachment: ${response.statusText}`);
    }
    return response.arrayBuffer();
}

function bufferToBase64(buffer: ArrayBuffer): string {
    const bytes = new Uint8Array(buffer);
    const chunkSize = 0x8000;
    let binary = '';
    for (let i = 0; i < bytes.length; i += chunkSize) {
        binary += String.fromCharCode(...bytes.subarray(i, i + chunkSize));
    }
    return btoa(binary);
}

/**
 * 将附件内容读取为 Base64。
 *
 * @param attachment 前端附件引用。
 * @returns Base64 数据与 MIME 类型。
 */
export async function readAttachmentAsBase64(
    attachment: Index
): Promise<{ data: string; mimeType: string }> {
    const buffer = await readAttachmentBuffer(attachment.path);
    return {
        data: bufferToBase64(buffer),
        mimeType: attachment.mimeType || 'image/png',
    };
}

/**
 * 将附件内容读取为文本；若检测到二进制内容则回退为 Base64。
 *
 * @param attachment 前端附件引用。
 * @returns 文本内容，以及是否按二进制处理。
 */
export async function readAttachmentAsText(
    attachment: Index
): Promise<{ content: string; isBinary: boolean }> {
    const buffer = await readAttachmentBuffer(attachment.path);
    const decoder = new TextDecoder('utf-8', { fatal: false });
    const text = decoder.decode(buffer);
    // 这里不依赖 MIME 判断文本性，而是用 NUL 和替换字符密度做保守检测，
    // 避免扩展名错误时把二进制内容直接塞进 prompt。
    const replacementCount = (text.match(/\uFFFD/g) || []).length;
    const isBinary = text.includes('\u0000') || replacementCount > Math.max(text.length * 0.01, 2);

    if (isBinary) {
        return { content: bufferToBase64(buffer), isBinary: true };
    }

    return { content: text, isBinary: false };
}

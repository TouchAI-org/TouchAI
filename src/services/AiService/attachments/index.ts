/*
 * Copyright (c) 2026. Qian Cheng. Licensed under GPL v3
 */

import { convertFileSrc } from '@tauri-apps/api/core';
import {
    extname as getFileExtension,
    fullName as getFileName,
    icon as getFileIcon,
    size as getFileSize,
} from 'tauri-plugin-fs-pro-api';

export type AttachmentSupportStatus = 'supported' | 'unsupported-image' | 'unsupported-file';

export interface Index {
    id: string;
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
    const extension = normalizeExtension(await getFileExtension(path));
    return imageMimeMap[extension] || 'image/png';
}

export async function createAttachment(type: 'image' | 'file', path: string): Promise<Index> {
    const id = `${Date.now()}-${Math.random().toString(36).substring(2, 5)}`;
    const name = await getFileName(path);
    const mimeType = await resolveMimeType(type, path);

    return {
        id,
        type,
        path,
        name,
        size: await getFileSize(path),
        preview: convertFileSrc(type == 'image' ? path : await getFileIcon(path, { size: 256 })),
        mimeType,
        supportStatus: 'supported',
    };
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

export async function readAttachmentAsBase64(
    attachment: Index
): Promise<{ data: string; mimeType: string }> {
    const buffer = await readAttachmentBuffer(attachment.path);
    return {
        data: bufferToBase64(buffer),
        mimeType: attachment.mimeType || 'image/png',
    };
}

export async function readAttachmentAsText(
    attachment: Index
): Promise<{ content: string; isBinary: boolean }> {
    const buffer = await readAttachmentBuffer(attachment.path);
    const decoder = new TextDecoder('utf-8', { fatal: false });
    const text = decoder.decode(buffer);
    const replacementCount = (text.match(/\uFFFD/g) || []).length;
    const isBinary = text.includes('\u0000') || replacementCount > Math.max(text.length * 0.01, 2);

    if (isBinary) {
        return { content: bufferToBase64(buffer), isBinary: true };
    }

    return { content: text, isBinary: false };
}

/*
 * Copyright (c) 2026. Qian Cheng. Licensed under GPL v3
 */

import { convertFileSrc } from '@tauri-apps/api/core';

import type { AttachmentPromptMeta } from '../../contracts/protocol';
import type { AttachmentIndex } from './types';

const BASE64_CHUNK_SIZE = 0x8000;
const BINARY_REPLACEMENT_RATIO_THRESHOLD = 0.01;

export async function readAttachmentBuffer(path: string): Promise<ArrayBuffer> {
    const response = await fetch(convertFileSrc(path));
    if (!response.ok) {
        throw new Error(`Failed to read attachment: ${response.statusText}`);
    }
    return response.arrayBuffer();
}

export function bufferToBase64(buffer: ArrayBuffer): string {
    const bytes = new Uint8Array(buffer);
    let binary = '';
    for (let index = 0; index < bytes.length; index += BASE64_CHUNK_SIZE) {
        binary += String.fromCharCode(...bytes.subarray(index, index + BASE64_CHUNK_SIZE));
    }
    return btoa(binary);
}

export function base64ToUint8Array(base64: string): Uint8Array {
    const binary = atob(base64);
    const bytes = new Uint8Array(binary.length);
    for (let index = 0; index < binary.length; index += 1) {
        bytes[index] = binary.charCodeAt(index);
    }
    return bytes;
}

export async function readAttachmentAsBase64(
    attachment: AttachmentIndex
): Promise<{ data: string; mimeType: string }> {
    const buffer = await readAttachmentBuffer(attachment.path);
    return {
        data: bufferToBase64(buffer),
        mimeType: attachment.mimeType || 'image/png',
    };
}

export async function readAttachmentAsText(
    attachment: AttachmentIndex
): Promise<{ content: string; isBinary: boolean }> {
    const buffer = await readAttachmentBuffer(attachment.path);
    const decoder = new TextDecoder('utf-8', { fatal: false });
    const text = decoder.decode(buffer);
    const replacementCount = (text.match(/\uFFFD/g) || []).length;
    const isBinary =
        text.includes('\u0000') ||
        replacementCount > Math.max(text.length * BINARY_REPLACEMENT_RATIO_THRESHOLD, 2);

    if (isBinary) {
        return { content: bufferToBase64(buffer), isBinary: true };
    }

    return { content: text, isBinary: false };
}

export function buildAttachmentAlias(order: number): string {
    return `A${order + 1}`;
}

export function buildAttachmentPromptMetas(attachments: AttachmentIndex[]): AttachmentPromptMeta[] {
    return attachments.map((attachment, order) => ({
        alias: buildAttachmentAlias(order),
        order,
        type: attachment.type,
        name: attachment.name,
        mimeType: attachment.mimeType ?? null,
        originPath: attachment.originPath,
        attachmentId: attachment.attachmentId ?? null,
        hash: attachment.hash ?? null,
    }));
}

export function formatAttachmentAnchorText(meta: AttachmentPromptMeta): string {
    return [
        `[Attachment ${meta.alias}]`,
        `name: ${meta.name}`,
        `type: ${meta.type}`,
        `origin_path: ${meta.originPath}`,
        `mime_type: ${meta.mimeType ?? 'unknown'}`,
    ].join('\n');
}

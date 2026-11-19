/*
 * Copyright (c) 2026. Qian Cheng. Licensed under GPL v3
 */

import { convertFileSrc, open, stat } from '@/platform/files';

import { normalizeImageBytes } from './image.io';
import { MAX_INLINE_IMAGE_BASE64_CHARS } from './limits';
import type { AttachmentIndex } from './types';

const BASE64_CHUNK_SIZE = 0x8000;
const BINARY_REPLACEMENT_RATIO_THRESHOLD = 0.01;

export interface AttachmentHead {
    bytes: Uint8Array;
    truncated: boolean;
}

export interface AttachmentTextPreview {
    content: string;
    isBinary: boolean;
    truncated: boolean;
}

export async function readAttachmentBuffer(
    path: string,
    signal?: AbortSignal
): Promise<ArrayBuffer> {
    signal?.throwIfAborted();
    const response = await fetch(convertFileSrc(path), { signal });
    signal?.throwIfAborted();
    if (!response.ok) {
        throw new Error(`Failed to read attachment: ${response.statusText}`);
    }
    return response.arrayBuffer();
}

/** Read at most `maxBytes + 1` bytes so callers can distinguish a complete file from a window. */
export async function readAttachmentHead(
    path: string,
    maxBytes: number,
    signal?: AbortSignal
): Promise<AttachmentHead> {
    signal?.throwIfAborted();
    const file = await open(path, { read: true });
    try {
        signal?.throwIfAborted();
        const buffer = new Uint8Array(maxBytes + 1);
        let total = 0;
        while (total < buffer.length) {
            const read = await file.read(buffer.subarray(total));
            signal?.throwIfAborted();
            if (read === null || read === 0) break;
            total += read;
        }
        return {
            bytes: buffer.subarray(0, Math.min(total, maxBytes)),
            truncated: total > maxBytes,
        };
    } finally {
        await file.close();
    }
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

/**
 * 将字节视图复制成 Web API 可安全接收的 ArrayBuffer。
 */
export function bytesToArrayBuffer(bytes: Uint8Array): ArrayBuffer {
    return bytes.slice().buffer;
}

export async function readAttachmentAsBase64(
    attachment: AttachmentIndex,
    options: { maxBytes?: number; signal?: AbortSignal } = {}
): Promise<{ data: string; mimeType: string } | null> {
    const maxBytes = options.maxBytes;
    options.signal?.throwIfAborted();
    if (maxBytes !== undefined) {
        const size = attachment.size ?? (await stat(attachment.path)).size;
        options.signal?.throwIfAborted();
        if (size > maxBytes) return null;
    }

    const buffer = await readAttachmentBuffer(attachment.path, options.signal);
    options.signal?.throwIfAborted();
    return {
        data: bufferToBase64(buffer),
        mimeType: attachment.mimeType || 'image/png',
    };
}

/**
 * Read an image for inline transport, normalizing legacy cached copies that
 * still exceed the byte budget. New attachments are normalized at persistence;
 * this path keeps old sessions usable after the transport policy changes.
 */
export async function readAttachmentImageForTransport(
    attachment: AttachmentIndex,
    options: { signal?: AbortSignal } = {}
): Promise<{ data: string; mimeType: string }> {
    const base64 = await readAttachmentAsBase64(attachment, options);
    options.signal?.throwIfAborted();
    if (!base64) throw new Error(`Failed to read attachment: ${attachment.path}`);
    if (base64.data.length <= MAX_INLINE_IMAGE_BASE64_CHARS) return base64;

    const normalized = await normalizeImageBytes({
        bytes: base64ToUint8Array(base64.data),
        mimeType: base64.mimeType,
    });
    options.signal?.throwIfAborted();
    if (!normalized.resized) return base64;

    return {
        data: bufferToBase64(bytesToArrayBuffer(normalized.bytes)),
        mimeType: normalized.mimeType,
    };
}

export async function readAttachmentAsText(
    attachment: AttachmentIndex,
    options: { maxBytes: number; signal?: AbortSignal }
): Promise<AttachmentTextPreview> {
    const head = await readAttachmentHead(attachment.path, options.maxBytes, options.signal);
    const decoder = new TextDecoder('utf-8', { fatal: false });
    const text = decoder.decode(head.bytes);
    const replacementCount = (text.match(/\uFFFD/g) || []).length;
    const isBinary =
        text.includes('\u0000') ||
        replacementCount > Math.max(text.length * BINARY_REPLACEMENT_RATIO_THRESHOLD, 2);

    return {
        content: isBinary ? '' : text,
        isBinary,
        truncated: head.truncated,
    };
}

export {
    buildAttachmentAlias,
    buildAttachmentPromptMetas,
    formatAttachmentAnchorText,
    formatAttachmentNotInlined,
} from './prompt';

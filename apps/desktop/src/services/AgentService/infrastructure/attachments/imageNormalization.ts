/*
 * Copyright (c) 2026. Qian Cheng. Licensed under GPL v3
 */

import {
    MAX_IMAGE_SOURCE_BYTES,
    MAX_INLINE_IMAGE_BASE64_CHARS,
    MAX_INLINE_IMAGE_EDGE,
} from './limits';

export interface NormalizedImageBytes {
    bytes: Uint8Array;
    mimeType: string;
    resized: boolean;
}

const RESIZABLE_MIME_TYPES = new Set(['image/png', 'image/jpeg', 'image/webp', 'image/bmp']);
const JPEG_QUALITIES = [0.92, 0.85, 0.78, 0.68];
const PNG_MIME_TYPE = 'image/png';
const JPEG_MIME_TYPE = 'image/jpeg';

function encodedSize(bytes: Uint8Array): number {
    return Math.ceil(bytes.byteLength / 3) * 4;
}

function canResize(): boolean {
    return (
        typeof createImageBitmap === 'function' &&
        (typeof OffscreenCanvas === 'function' || typeof document !== 'undefined')
    );
}

function createCanvas(width: number, height: number): CanvasLike | null {
    if (typeof OffscreenCanvas === 'function') {
        const canvas = new OffscreenCanvas(width, height);
        const context = canvas.getContext('2d');
        return context ? { canvas, context } : null;
    }
    if (typeof document === 'undefined') return null;
    const canvas = document.createElement('canvas');
    canvas.width = width;
    canvas.height = height;
    const context = canvas.getContext('2d');
    return context ? { canvas, context } : null;
}

interface CanvasLike {
    canvas: OffscreenCanvas | HTMLCanvasElement;
    context: OffscreenCanvasRenderingContext2D | CanvasRenderingContext2D;
}

async function encodeCanvas(
    target: CanvasLike,
    mimeType: string,
    quality?: number
): Promise<Uint8Array | null> {
    const canvas = target.canvas;
    const blob = isHtmlCanvas(canvas)
        ? await new Promise<Blob | null>((resolve) => canvas.toBlob(resolve, mimeType, quality))
        : await canvas.convertToBlob({ type: mimeType, quality });
    if (!blob || blob.type !== mimeType) return null;
    return new Uint8Array(await blob.arrayBuffer());
}

async function encodeCandidates(
    target: CanvasLike,
    originalMimeType: string
): Promise<Array<{ bytes: Uint8Array; mimeType: string }>> {
    const candidates: Array<{ bytes: Uint8Array; mimeType: string }> = [];
    const png = await encodeCanvas(target, PNG_MIME_TYPE);
    if (png) candidates.push({ bytes: png, mimeType: PNG_MIME_TYPE });

    // JPEG has no alpha channel; a white matte prevents transparent pixels from turning black.
    const context = target.context;
    context.save();
    context.fillStyle = '#ffffff';
    context.fillRect(0, 0, target.canvas.width, target.canvas.height);
    context.restore();

    for (const quality of JPEG_QUALITIES) {
        const jpeg = await encodeCanvas(target, JPEG_MIME_TYPE, quality);
        if (jpeg) candidates.push({ bytes: jpeg, mimeType: JPEG_MIME_TYPE });
    }

    // Keep PNG first for opaque screenshots and transparent graphics; otherwise the
    // caller picks the smallest candidate that fits the transport budget.
    return candidates.sort((left, right) => {
        if (left.mimeType === originalMimeType && right.mimeType !== originalMimeType) return -1;
        if (right.mimeType === originalMimeType && left.mimeType !== originalMimeType) return 1;
        return left.bytes.byteLength - right.bytes.byteLength;
    });
}

/**
 * Fit an image inside the inline transport budget.
 *
 * Unsupported formats, unavailable canvas support and unreadable images are
 * returned unchanged: the attachment must still reach the model when the
 * renderer cannot decode it.
 */
export async function normalizeImageBytes(input: {
    bytes: Uint8Array;
    mimeType: string;
}): Promise<NormalizedImageBytes> {
    const original: NormalizedImageBytes = {
        bytes: input.bytes,
        mimeType: input.mimeType,
        resized: false,
    };
    if (
        !RESIZABLE_MIME_TYPES.has(input.mimeType.toLowerCase()) ||
        input.bytes.byteLength > MAX_IMAGE_SOURCE_BYTES ||
        !canResize()
    ) {
        return original;
    }

    let bitmap: ImageBitmap;
    try {
        bitmap = await createImageBitmap(
            new Blob([toArrayBuffer(input.bytes)], { type: input.mimeType }),
            { imageOrientation: 'from-image' }
        );
    } catch {
        return original;
    }

    try {
        if (
            Math.max(bitmap.width, bitmap.height) <= MAX_INLINE_IMAGE_EDGE &&
            encodedSize(input.bytes) <= MAX_INLINE_IMAGE_BASE64_CHARS
        ) {
            return original;
        }

        const scale = Math.min(1, MAX_INLINE_IMAGE_EDGE / Math.max(bitmap.width, bitmap.height));
        let width = Math.max(1, Math.round(bitmap.width * scale));
        let height = Math.max(1, Math.round(bitmap.height * scale));

        while (true) {
            const target = createCanvas(width, height);
            if (!target) return original;
            target.context.imageSmoothingEnabled = true;
            target.context.imageSmoothingQuality = 'high';
            target.context.drawImage(bitmap, 0, 0, width, height);

            const candidates = await encodeCandidates(target, input.mimeType);
            const fitting = candidates.find(
                (candidate) => encodedSize(candidate.bytes) <= MAX_INLINE_IMAGE_BASE64_CHARS
            );
            if (fitting) {
                return {
                    bytes: fitting.bytes,
                    mimeType: fitting.mimeType,
                    resized: true,
                };
            }

            if (width === 1 && height === 1) return original;
            width = Math.max(1, Math.floor(width * 0.75));
            height = Math.max(1, Math.floor(height * 0.75));
        }
    } finally {
        bitmap.close();
    }
}

function isHtmlCanvas(canvas: OffscreenCanvas | HTMLCanvasElement): canvas is HTMLCanvasElement {
    return typeof HTMLCanvasElement !== 'undefined' && canvas instanceof HTMLCanvasElement;
}

function toArrayBuffer(bytes: Uint8Array): ArrayBuffer {
    return bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength) as ArrayBuffer;
}

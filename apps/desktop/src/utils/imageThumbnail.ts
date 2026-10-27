// Copyright (c) 2026. Qian Cheng. Licensed under GPL v3

/**
 * 会话图片缩略图。
 *
 * 聊天里的图片由 CSS 限制为 200px 高，但 `<img>` 仍会按原图解码——
 * 手机照片（4000×3000）解码后可能占用数十 MB 显存/内存。
 * 这里在可见时按显示尺寸生成缩小位图，并按「源 + 目标宽度」缓存 object URL，
 * 离开可见区的缓存按 LRU 回收。
 */

/** 固定缓存预算：同时保留的缩略图张数（按最近使用排序）。 */
const MAX_THUMBNAILS = 40;

const cache = new Map<string, string>();
const pending = new Map<string, Promise<string>>();

function cacheKey(source: string, width: number): string {
    return `${width}|${source}`;
}

/** 触摸一次缓存条目，维持 LRU 顺序。 */
function touch(key: string, url: string): void {
    cache.delete(key);
    cache.set(key, url);
}

function evictOverflow(): void {
    while (cache.size > MAX_THUMBNAILS) {
        const oldestKey = cache.keys().next().value;
        if (oldestKey === undefined) {
            return;
        }

        const url = cache.get(oldestKey);
        cache.delete(oldestKey);
        if (url) {
            URL.revokeObjectURL(url);
        }
    }
}

async function decodeImage(source: string): Promise<ImageBitmap | HTMLImageElement> {
    const response = await fetch(source);
    if (!response.ok) {
        throw new Error(`Failed to read image: ${response.statusText}`);
    }

    const blob = await response.blob();
    if (typeof createImageBitmap === 'function') {
        return await createImageBitmap(blob);
    }

    const url = URL.createObjectURL(blob);
    try {
        const image = new Image();
        image.src = url;
        await image.decode();
        return image;
    } finally {
        URL.revokeObjectURL(url);
    }
}

/**
 * 取得指定显示宽度的缩略图 URL。
 *
 * 同一源 + 宽度只会解码一次；并发请求共享同一次解码。
 */
export async function getImageThumbnail(source: string, width: number): Promise<string> {
    const targetWidth = Math.max(1, Math.round(width));
    const key = cacheKey(source, targetWidth);
    const cached = cache.get(key);
    if (cached) {
        touch(key, cached);
        return cached;
    }

    const inFlight = pending.get(key);
    if (inFlight) {
        return await inFlight;
    }

    const task = (async () => {
        const bitmap = await decodeImage(source);
        const sourceWidth = 'width' in bitmap ? bitmap.width : 0;
        const sourceHeight = 'height' in bitmap ? bitmap.height : 0;
        const scale = sourceWidth > 0 ? Math.min(1, targetWidth / sourceWidth) : 1;
        const thumbWidth = Math.max(1, Math.round(sourceWidth * scale));
        const thumbHeight = Math.max(1, Math.round(sourceHeight * scale));

        const canvas = document.createElement('canvas');
        canvas.width = thumbWidth;
        canvas.height = thumbHeight;
        const context = canvas.getContext('2d');
        if (!context) {
            throw new Error('Canvas 2D context is unavailable');
        }
        context.drawImage(bitmap as CanvasImageSource, 0, 0, thumbWidth, thumbHeight);
        if ('close' in bitmap && typeof bitmap.close === 'function') {
            bitmap.close();
        }

        const blob = await new Promise<Blob | null>((resolve) => {
            canvas.toBlob(resolve, 'image/webp', 0.82);
        });
        if (!blob) {
            throw new Error('Failed to encode thumbnail');
        }

        return URL.createObjectURL(blob);
    })();

    pending.set(key, task);
    try {
        const url = await task;
        cache.set(key, url);
        evictOverflow();
        return url;
    } finally {
        pending.delete(key);
    }
}

/** 仅测试使用：清空缓存并释放 URL。 */
export function resetImageThumbnailCache(): void {
    for (const url of cache.values()) {
        URL.revokeObjectURL(url);
    }
    cache.clear();
    pending.clear();
}

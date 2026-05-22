// Copyright (c) 2026. Qian Cheng. Licensed under GPL v3.

export const IMAGE_EXTENSIONS = new Set([
    'jpg',
    'jpeg',
    'png',
    'gif',
    'webp',
    'bmp',
    'svg',
    'avif',
]);

export function getPathExtension(path: string): string {
    const normalizedPath = path.trim();
    const separatorIndex = Math.max(
        normalizedPath.lastIndexOf('/'),
        normalizedPath.lastIndexOf('\\')
    );
    const fileName =
        separatorIndex >= 0 ? normalizedPath.slice(separatorIndex + 1) : normalizedPath;
    const dotIndex = fileName.lastIndexOf('.');
    if (dotIndex <= 0 || dotIndex === fileName.length - 1) {
        return '';
    }
    return fileName.slice(dotIndex + 1).toLowerCase();
}

export function isImagePath(path: string): boolean {
    return IMAGE_EXTENSIONS.has(getPathExtension(path));
}

// Copyright (c) 2026. Qian Cheng. Licensed under GPL v3

import { stat } from '@tauri-apps/plugin-fs';

import { isImagePath } from '@/utils/path';

export interface PastedPathAttachment {
    type: 'image' | 'file';
    path: string;
}

type PathStat = (path: string) => Promise<{ isFile?: boolean; isDirectory?: boolean }>;

const defaultStat: PathStat = (path) => stat(path);

/**
 * Resolve a clipboard text value that is exactly one existing local file or folder path.
 *
 * Explorer's "Copy as path" adds quotes, and browsers copy file links as file URLs;
 * both are normalized before the existence check so the tag points at the real file.
 */
export async function resolvePastedPathAttachment(
    text: string,
    pathStat: PathStat = defaultStat
): Promise<PastedPathAttachment | null> {
    const path = normalizePastedPath(text);
    if (!path) return null;

    try {
        const info = await pathStat(path);
        if (!info.isFile && !info.isDirectory) return null;
        return {
            type: info.isFile && isImagePath(path) ? 'image' : 'file',
            path,
        };
    } catch {
        return null;
    }
}

export function normalizePastedPath(text: string): string | null {
    const trimmed = text.trim();
    if (!trimmed || /[\r\n]/.test(trimmed)) return null;

    const unquoted =
        (trimmed.startsWith('"') && trimmed.endsWith('"')) ||
        (trimmed.startsWith("'") && trimmed.endsWith("'"))
            ? trimmed.slice(1, -1).trim()
            : trimmed;
    if (!unquoted) return null;

    if (!/^file:\/\//i.test(unquoted)) return unquoted;

    try {
        const url = new URL(unquoted);
        let path = decodeURIComponent(url.pathname);
        if (/^\/[A-Za-z]:[\\/]/.test(path)) {
            path = path.slice(1).replace(/\//g, '\\');
        }
        return path || null;
    } catch {
        return null;
    }
}

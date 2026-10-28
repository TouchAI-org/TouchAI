/**
 * Cuts a pull-request diff down to the files that can change the interface.
 *
 * The model only plans what it can see. Slicing the whole diff from the top
 * drops the interface files of a large pull request, so the diff is split per
 * file first, non-interface files are removed, and every kept hunk keeps its
 * file name.
 */

import { isUiPath } from './paths.mjs';

export const MAX_DIFF_CHARS = 24000;
export const MAX_FILE_CHARS = 8000;

/**
 * @param {string} diff
 * @returns {Array<{ path: string, text: string }>}
 */
export function splitDiff(diff) {
    const files = [];
    let current = null;

    for (const line of String(diff ?? '').split('\n')) {
        if (line.startsWith('diff --git ')) {
            const match = /^diff --git a\/(.+?) b\/(.+)$/.exec(line);
            current = { path: match?.[2] ?? '', text: `${line}\n` };
            files.push(current);
            continue;
        }

        if (current) {
            current.text += `${line}\n`;
        }
    }

    return files.filter((file) => file.path);
}

function truncateFile(file, limit) {
    if (file.text.length <= limit) {
        return file.text;
    }

    return `${file.text.slice(0, limit)}\n... (cut, ${file.text.length - limit} characters)\n`;
}

/**
 * @param {string} diff
 * @param {{ maxChars?: number, maxFileChars?: number }} [options]
 * @returns {{ text: string, files: string[], dropped: string[], truncated: boolean }}
 */
export function selectUiDiff(diff, options = {}) {
    const maxChars = options.maxChars ?? MAX_DIFF_CHARS;
    const maxFileChars = options.maxFileChars ?? MAX_FILE_CHARS;
    const files = splitDiff(diff);
    const kept = [];
    const dropped = [];

    for (const file of files) {
        if (isUiPath(file.path)) {
            kept.push(file);
        } else {
            dropped.push(file.path);
        }
    }

    // The interface files are what the plan is about; if even they do not fit,
    // every file still gets a share rather than the first one taking it all.
    const budget = Math.max(2000, Math.floor(maxChars / Math.max(1, kept.length)));
    const perFile = Math.min(maxFileChars, budget);
    const parts = [];
    let total = 0;
    let truncated = false;

    for (const file of kept) {
        const text = truncateFile(file, perFile);

        if (total + text.length > maxChars) {
            truncated = true;
            break;
        }

        truncated ||= text.length < file.text.length;
        parts.push(text);
        total += text.length;
    }

    return {
        text: parts.join(''),
        files: kept.map((file) => file.path),
        dropped,
        truncated,
    };
}

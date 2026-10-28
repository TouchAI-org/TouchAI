/**
 * Locale parity without booting the app.
 *
 * Both message objects are plain object literals, so the keys can be read
 * statically. A key that exists in one locale and not the other is a visible
 * defect: the missing side falls back to the raw key or the other language.
 */

import fs from 'node:fs';
import path from 'node:path';

function objectBody(source, startIndex) {
    let depth = 0;
    let started = false;

    for (let index = startIndex; index < source.length; index += 1) {
        const character = source[index];

        if (character === '{') {
            depth += 1;
            started = true;
        } else if (character === '}') {
            depth -= 1;

            if (started && depth === 0) {
                return source.slice(startIndex, index + 1);
            }
        }
    }

    return null;
}

export function extractKeys(source, variableName) {
    const declaration = new RegExp(`const\\s+${variableName}\\s*[:=]`).exec(source);

    if (!declaration) {
        return null;
    }

    const braceIndex = source.indexOf('{', declaration.index);

    if (braceIndex === -1) {
        return null;
    }

    const body = objectBody(source, braceIndex);

    if (!body) {
        return null;
    }

    const keys = new Set();
    const keyPattern = /^\s*'([^']+)'\s*:/gm;
    let match = keyPattern.exec(body);

    while (match) {
        keys.add(match[1]);
        match = keyPattern.exec(body);
    }

    return keys;
}

/**
 * Each locale pair lives in its own module and does not share variable names, so
 * the pair is named per file instead of guessed.
 */
export const LOCALE_FILES = [
    { file: 'messages.ts', chinese: 'zhCNMessages', english: 'enUSMessages' },
    { file: 'usageMessages.ts', chinese: 'usageMessagesZhCN', english: 'usageMessagesEnUS' },
];

/**
 * @param {string} i18nDirectory
 * @returns {{ checked: boolean, ok: boolean, detail: string }}
 */
export function checkLocaleParity(i18nDirectory) {
    const missingInEnglish = [];
    const missingInChinese = [];

    for (const pair of LOCALE_FILES) {
        const file = path.join(i18nDirectory, pair.file);

        if (!fs.existsSync(file)) {
            return { checked: false, ok: false, detail: `${pair.file} is missing` };
        }

        const source = fs.readFileSync(file, 'utf8');
        const zh = extractKeys(source, pair.chinese);
        const en = extractKeys(source, pair.english);

        if (!zh || !en) {
            return {
                checked: false,
                ok: false,
                detail: `${pair.file} does not declare both locale objects`,
            };
        }

        for (const key of zh) {
            if (!en.has(key)) {
                missingInEnglish.push(key);
            }
        }

        for (const key of en) {
            if (!zh.has(key)) {
                missingInChinese.push(key);
            }
        }
    }

    if (missingInEnglish.length === 0 && missingInChinese.length === 0) {
        return { checked: true, ok: true, detail: 'zh-CN and en-US declare the same keys' };
    }

    const parts = [];

    if (missingInEnglish.length > 0) {
        parts.push(`missing in en-US: ${missingInEnglish.slice(0, 5).join(', ')}`);
    }

    if (missingInChinese.length > 0) {
        parts.push(`missing in zh-CN: ${missingInChinese.slice(0, 5).join(', ')}`);
    }

    return { checked: true, ok: false, detail: parts.join('; ') };
}

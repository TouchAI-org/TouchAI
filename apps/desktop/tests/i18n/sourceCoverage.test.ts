import { readFileSync } from 'node:fs';
import { relative, resolve } from 'node:path';

import { describe, expect, it } from 'vitest';

import { zhToEnTextMap } from '@/i18n/textMap';

const repoRoot = resolve(__dirname, '../..');

const SOURCE_FILES = Object.keys(
    import.meta.glob('/src/{components,views}/**/*.vue', { query: '?raw', import: 'default' })
)
    .map((path) => path.replace(/^\//, ''))
    .filter((path) => !path.includes('/ui/'));

const CODE_SOURCE_FILES = Object.keys(
    import.meta.glob('/src/{components,views,services}/**/*.{ts,vue}', {
        query: '?raw',
        import: 'default',
    })
)
    .map((path) => path.replace(/^\//, ''))
    .filter((path) => !path.includes('/EventService/') && !path.includes('/LoggerService/'));

const CHINESE_TEXT_RE = /\p{Script=Han}/u;
const QUOTED_STRING_RE = /(['"`])((?:\\.|(?!\1)[\s\S])*?)\1/g;
const ATTRIBUTE_RE = /(?:^|\s)(:?[\w:-]+)\s*=\s*(["'])([\s\S]*?)\2/g;
const MUSTACHE_RE = /\{\{[\s\S]*?\}\}/g;
const COMMENT_RE = /<!--[\s\S]*?-->|\/\*[\s\S]*?\*\/|^\s*\/\/.*$/gm;

const IGNORED_TEXT = new Set([
    '千诚',
    '通义',
    '智谱',
    '豆包',
    '混元',
    '阿里云百炼',
    'Anthropic 兼容',
    'OpenAI 兼容',
    '请输入内容...',
]);

function normalizeText(value: string): string {
    return value
        .replace(/\\n/g, '\n')
        .replace(/&quot;/g, '"')
        .replace(/&apos;/g, "'")
        .replace(/&nbsp;/g, ' ')
        .replace(/\s+/g, ' ')
        .trim();
}

function hasChinese(value: string): boolean {
    return CHINESE_TEXT_RE.test(value);
}

function shouldCheckText(value: string): boolean {
    if (!value || !hasChinese(value) || IGNORED_TEXT.has(value)) {
        return false;
    }

    if (/^Copyright \(c\)/.test(value)) {
        return false;
    }

    if (/^[\w\s:/.\-{}[\](),'"|+]+$/.test(value)) {
        return false;
    }

    return true;
}

function extractVueTemplate(source: string): string {
    return /<template>([\s\S]*?)<\/template>/.exec(source)?.[1] ?? '';
}

function collectTemplateTexts(source: string): string[] {
    const template = extractVueTemplate(source).replace(COMMENT_RE, '');
    const texts = new Set<string>();

    for (const match of template.replace(MUSTACHE_RE, '').matchAll(/>([^<>]+)</g)) {
        const text = normalizeText(match[1] ?? '');
        if (shouldCheckText(text)) {
            texts.add(text);
        }
    }

    for (const match of template.matchAll(ATTRIBUTE_RE)) {
        const attributeName = match[1] ?? '';
        const attributeValue = match[3] ?? '';
        if (attributeName.startsWith(':')) {
            for (const nested of attributeValue.matchAll(QUOTED_STRING_RE)) {
                const text = normalizeText(nested[2] ?? '');
                if (shouldCheckText(text)) {
                    texts.add(text);
                }
            }
            continue;
        }

        const text = normalizeText(attributeValue);
        if (shouldCheckText(text)) {
            texts.add(text);
        }
    }

    for (const mustache of template.matchAll(MUSTACHE_RE)) {
        for (const nested of (mustache[0] ?? '').matchAll(QUOTED_STRING_RE)) {
            const text = normalizeText(nested[2] ?? '');
            if (shouldCheckText(text)) {
                texts.add(text);
            }
        }
    }

    return [...texts];
}

function collectExplicitRuntimeTexts(source: string): string[] {
    const sourceWithoutComments = source.replace(COMMENT_RE, '');
    const texts = new Set<string>();

    for (const call of sourceWithoutComments.matchAll(
        /\btt\(\s*(['"`])((?:\\.|(?!\1)[\s\S])*?)\1/g
    )) {
        const text = normalizeText(call[2] ?? '');
        if (shouldCheckText(text)) {
            texts.add(text);
        }
    }

    for (const call of sourceWithoutComments.matchAll(
        /\b(?:success|error|warning|notify)\(\s*(['"`])((?:\\.|(?!\1)[\s\S])*?)\1/g
    )) {
        const text = normalizeText(call[2] ?? '');
        if (shouldCheckText(text)) {
            texts.add(text);
        }
    }

    for (const property of sourceWithoutComments.matchAll(
        /\b(?:title|message|body|confirmText|cancelText|label|description)\s*:\s*(['"`])((?:\\.|(?!\1)[\s\S])*?)\1/g
    )) {
        const text = normalizeText(property[2] ?? '');
        if (shouldCheckText(text)) {
            texts.add(text);
        }
    }

    return [...texts];
}

function formatMissing(missing: Array<{ file: string; text: string }>): string {
    return missing
        .map(({ file, text }) => `${file}: ${text}`)
        .sort((left, right) => left.localeCompare(right))
        .join('\n');
}

describe('i18n source coverage guard', () => {
    it('has English mappings for user-facing Chinese strings in Vue templates', () => {
        const missing: Array<{ file: string; text: string }> = [];

        for (const file of SOURCE_FILES) {
            const source = readFileSync(resolve(repoRoot, file), 'utf8');
            for (const text of collectTemplateTexts(source)) {
                if (!(text in zhToEnTextMap)) {
                    missing.push({ file: relative(repoRoot, file), text });
                }
            }
        }

        expect(formatMissing(missing)).toBe('');
    });

    it('has English mappings for explicit runtime Chinese messages', () => {
        const missing: Array<{ file: string; text: string }> = [];

        for (const file of CODE_SOURCE_FILES) {
            const source = readFileSync(resolve(repoRoot, file), 'utf8');
            for (const text of collectExplicitRuntimeTexts(source)) {
                if (!(text in zhToEnTextMap)) {
                    missing.push({ file: relative(repoRoot, file), text });
                }
            }
        }

        expect(formatMissing(missing)).toBe('');
    });
});

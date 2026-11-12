import { parseDocument } from 'yaml';

import type { ParsedSkill } from './types';

interface FrontmatterParseResult {
    data: Record<string, unknown>;
    body: string;
}

function parseYamlMetadata(text: string): Record<string, unknown> {
    if (text.length > 64 * 1024) {
        throw new Error('Skill metadata exceeds 64 KiB');
    }
    let data: unknown;
    try {
        // Inspect diagnostics without emitting warnings that contain source excerpts.
        const document = parseDocument(text, { uniqueKeys: true, prettyErrors: false });
        if (document.errors.length > 0) throw new Error('Invalid YAML document');
        data = document.toJS({ maxAliasCount: 0 });
    } catch {
        // YAML diagnostics include source excerpts, which must not enter tool history.
        throw new Error('Skill metadata is invalid YAML');
    }
    if (!data || typeof data !== 'object' || Array.isArray(data)) {
        throw new Error('Skill metadata must be a YAML mapping');
    }
    return data as Record<string, unknown>;
}

function splitFrontmatter(markdown: string): FrontmatterParseResult {
    const normalized = markdown.replace(/^\uFEFF/, '');
    if (!normalized.startsWith('---\n') && !normalized.startsWith('---\r\n')) {
        throw new Error('SKILL.md must start with YAML frontmatter');
    }

    const match = normalized.match(/^---\r?\n([\s\S]*?)\r?\n---(?:\r?\n|$)/);
    if (!match) {
        throw new Error('SKILL.md frontmatter is not closed');
    }

    return {
        data: parseYamlMetadata(match[1] ?? ''),
        body: normalized.slice(match[0].length).trim(),
    };
}

function requireString(data: Record<string, unknown>, key: string): string {
    const value = data[key];
    if (typeof value !== 'string' || !value.trim()) {
        throw new Error(`SKILL.md frontmatter must include ${key}`);
    }
    return value.trim();
}

function readShortDescription(data: Record<string, unknown>): string | null {
    const metadata = data.metadata;
    if (!metadata || typeof metadata !== 'object') {
        return null;
    }

    const value = (metadata as Record<string, unknown>)['short-description'];
    return typeof value === 'string' && value.trim() ? value.trim() : null;
}

function getDirectory(path: string): string {
    const normalizedPath = path.replace(/\\/g, '/');
    const separatorIndex = normalizedPath.lastIndexOf('/');
    return separatorIndex >= 0 ? normalizedPath.slice(0, separatorIndex) : '';
}

export function parseSkillMarkdown(markdown: string, path: string): ParsedSkill {
    const parsed = splitFrontmatter(markdown);
    return {
        name: requireString(parsed.data, 'name'),
        description: requireString(parsed.data, 'description'),
        shortDescription: readShortDescription(parsed.data),
        path,
        directory: getDirectory(path),
        body: parsed.body,
    };
}

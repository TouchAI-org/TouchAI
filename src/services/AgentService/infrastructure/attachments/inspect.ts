/*
 * Copyright (c) 2026. Qian Cheng. Licensed under GPL v3
 */

import type {
    AttachmentDerivedKind,
    AttachmentPromptMeta,
    AttachmentSemanticIntent,
} from '../../contracts/protocol';
import { buildAttachmentPromptMetas, readAttachmentBuffer } from './content';
import type { AttachmentIndex } from './types';

const BINARY_REPLACEMENT_RATIO_THRESHOLD = 0.01;
const DIRECTORY_MIME_TYPE = 'application/x-directory';
const DEFAULT_TEXT_MIME_TYPE = 'text/plain';
const DEFAULT_BINARY_MIME_TYPE = 'application/octet-stream';

const structuredTextExtensions = new Set([
    'csv',
    'ini',
    'json',
    'jsonl',
    'toml',
    'xml',
    'yaml',
    'yml',
]);

const codeExtensions = new Set([
    'c',
    'cc',
    'cpp',
    'cs',
    'css',
    'go',
    'h',
    'hpp',
    'html',
    'java',
    'js',
    'jsx',
    'kt',
    'kts',
    'lua',
    'php',
    'ps1',
    'py',
    'rb',
    'rs',
    'scss',
    'sh',
    'sql',
    'swift',
    'ts',
    'tsx',
    'vue',
]);

const plainTextExtensions = new Set(['log', 'md', 'mdx', 'txt']);

const extensionMimeMap: Record<string, string> = {
    c: 'text/plain',
    cc: 'text/plain',
    cpp: 'text/plain',
    css: 'text/css',
    csv: 'text/csv',
    go: 'text/plain',
    h: 'text/plain',
    hpp: 'text/plain',
    html: 'text/html',
    ini: 'text/plain',
    java: 'text/plain',
    js: 'text/javascript',
    json: 'application/json',
    jsonl: 'application/jsonl',
    jsx: 'text/javascript',
    kt: 'text/plain',
    kts: 'text/plain',
    log: 'text/plain',
    lua: 'text/plain',
    md: 'text/markdown',
    mdx: 'text/markdown',
    pdf: 'application/pdf',
    php: 'text/plain',
    ps1: 'text/plain',
    py: 'text/x-python',
    rb: 'text/plain',
    rs: 'text/plain',
    scss: 'text/x-scss',
    sh: 'text/x-shellscript',
    sql: 'text/plain',
    swift: 'text/plain',
    toml: 'application/toml',
    ts: 'text/typescript',
    tsx: 'text/typescript',
    txt: 'text/plain',
    vue: 'text/plain',
    xml: 'application/xml',
    yaml: 'application/yaml',
    yml: 'application/yaml',
};

export interface AttachmentInspection {
    attachment: AttachmentIndex;
    meta: AttachmentPromptMeta;
    kind: AttachmentDerivedKind;
    semanticIntent: AttachmentSemanticIntent;
    mimeType: string;
    size: number | null;
    supportStatus: AttachmentIndex['supportStatus'] | null;
}

function getAttachmentExtension(name: string): string {
    const lastDotIndex = name.lastIndexOf('.');
    return lastDotIndex < 0
        ? ''
        : name
              .slice(lastDotIndex + 1)
              .trim()
              .toLowerCase();
}

function inferMimeTypeFromExtension(extension: string): string | undefined {
    return extensionMimeMap[extension];
}

function inferKindFromNameAndMime(
    attachment: Pick<AttachmentIndex, 'type' | 'mimeType' | 'name'>
): AttachmentDerivedKind | null {
    const mimeType = attachment.mimeType?.toLowerCase() ?? '';
    const extension = getAttachmentExtension(attachment.name);

    if (attachment.type === 'image' || mimeType.startsWith('image/')) {
        return 'image';
    }

    if (mimeType === DIRECTORY_MIME_TYPE) {
        return 'directory';
    }

    if (mimeType === 'application/pdf' || extension === 'pdf') {
        return 'pdf';
    }

    if (
        mimeType === 'application/json' ||
        mimeType === 'application/xml' ||
        mimeType === 'application/yaml' ||
        mimeType === 'application/toml' ||
        mimeType === 'text/csv' ||
        structuredTextExtensions.has(extension)
    ) {
        return 'structured-text';
    }

    if (mimeType.startsWith('text/') && codeExtensions.has(extension)) {
        return 'code';
    }

    if (codeExtensions.has(extension)) {
        return 'code';
    }

    if (mimeType.startsWith('text/') || plainTextExtensions.has(extension)) {
        return 'text';
    }

    return null;
}

function resolveMimeType(
    attachment: Pick<AttachmentIndex, 'type' | 'mimeType' | 'name'>,
    kind: AttachmentDerivedKind
): string {
    if (attachment.mimeType) {
        return attachment.mimeType;
    }

    if (kind === 'image') {
        return 'image/png';
    }

    if (kind === 'directory') {
        return DIRECTORY_MIME_TYPE;
    }

    const extension = getAttachmentExtension(attachment.name);
    return (
        inferMimeTypeFromExtension(extension) ??
        (kind === 'binary' ? DEFAULT_BINARY_MIME_TYPE : DEFAULT_TEXT_MIME_TYPE)
    );
}

async function isAttachmentBinary(attachment: AttachmentIndex): Promise<boolean> {
    const buffer = await readAttachmentBuffer(attachment.path);
    const decoder = new TextDecoder('utf-8', { fatal: false });
    const text = decoder.decode(buffer);
    const replacementCount = (text.match(/\uFFFD/g) || []).length;

    return (
        text.includes('\u0000') ||
        replacementCount > Math.max(text.length * BINARY_REPLACEMENT_RATIO_THRESHOLD, 2)
    );
}

function inferSemanticIntent(kind: AttachmentDerivedKind): AttachmentSemanticIntent {
    switch (kind) {
        case 'image':
            return 'visual-reference';
        case 'pdf':
            return 'document-content';
        case 'directory':
            return 'directory-reference';
        case 'binary':
            return 'binary-content';
        default:
            return 'textual-content';
    }
}

export async function inspectAttachment(
    attachment: AttachmentIndex,
    order: number
): Promise<AttachmentInspection> {
    const meta = buildAttachmentPromptMetas([attachment])[0] ?? {
        alias: `A${order + 1}`,
        order,
        type: attachment.type,
        name: attachment.name,
        mimeType: attachment.mimeType ?? null,
        originPath: attachment.originPath,
        attachmentId: attachment.attachmentId ?? null,
        hash: attachment.hash ?? null,
    };
    const inferredKind = inferKindFromNameAndMime(attachment);
    let resolvedKind = inferredKind ?? 'binary';

    if (
        attachment.type === 'file' &&
        resolvedKind !== 'image' &&
        resolvedKind !== 'pdf' &&
        resolvedKind !== 'directory'
    ) {
        const binary = await isAttachmentBinary(attachment);
        if (binary) {
            resolvedKind = 'binary';
        } else if (inferredKind === null) {
            resolvedKind = 'text';
        }
    }

    return {
        attachment,
        meta: {
            ...meta,
            alias: `A${order + 1}`,
            order,
        },
        kind: resolvedKind,
        semanticIntent: inferSemanticIntent(resolvedKind),
        mimeType: resolveMimeType(attachment, resolvedKind),
        size: attachment.size ?? null,
        supportStatus: attachment.supportStatus ?? null,
    };
}

export async function inspectAttachments(
    attachments: AttachmentIndex[]
): Promise<AttachmentInspection[]> {
    const metas = buildAttachmentPromptMetas(attachments);

    return Promise.all(
        attachments.map(async (attachment, order) => {
            const inspection = await inspectAttachment(attachment, order);
            return {
                ...inspection,
                meta: metas[order]
                    ? {
                          ...inspection.meta,
                          ...metas[order],
                      }
                    : inspection.meta,
            };
        })
    );
}

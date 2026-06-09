import type { AttachmentIndex } from '@/services/AgentService/infrastructure/attachments';
import { truncateText } from '@/utils/text';

import { formatRedactedJson, redactBrowserValue, redactUrl } from './redaction';

function isRecord(value: unknown): value is Record<string, unknown> {
    return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

function getString(value: Record<string, unknown>, keys: string[]): string | null {
    for (const key of keys) {
        const entry = value[key];
        if (typeof entry === 'string' && entry.trim()) {
            return entry;
        }
    }

    return null;
}

function isScreenshotPayloadKey(key: string): boolean {
    return ['base64', 'dataUrl', 'data_url', 'screenshotBase64', 'screenshot_base64'].includes(key);
}

function isImplementationDetailKey(key: string): boolean {
    return key === 'endpoint';
}

function stripScreenshotPayloads(value: unknown): unknown {
    if (Array.isArray(value)) {
        return value.map(stripScreenshotPayloads);
    }

    if (!isRecord(value)) {
        return value;
    }

    return Object.fromEntries(
        Object.entries(value)
            .filter(([key]) => !isScreenshotPayloadKey(key) && !isImplementationDetailKey(key))
            .map(([key, entry]) => [key, stripScreenshotPayloads(entry)])
    );
}

function cleanMarkdownAltText(value: string): string {
    return value
        .replace(/\s+/g, ' ')
        .replace(/[[\]\\]/g, '')
        .trim();
}

function formatScreenshotMarkdown(name: string, url: string | null): string {
    const altText = cleanMarkdownAltText(
        url ? `Browser screenshot of ${redactUrl(url)}` : 'Browser screenshot'
    );
    return `![${altText}](attachment:${name})`;
}

function formatScreenshotResponse(response: Record<string, unknown>): {
    result: string;
    attachments?: AttachmentIndex[];
} {
    const path = getString(response, ['path', 'filePath', 'file_path']);
    const url = getString(response, ['url', 'currentUrl', 'current_url', 'pageUrl', 'page_url']);
    const mimeType = getString(response, ['mimeType', 'mime_type']) ?? 'image/png';
    const width = typeof response.width === 'number' ? response.width : null;
    const height = typeof response.height === 'number' ? response.height : null;
    const dimensions = width && height ? `${width}x${height}` : 'unknown dimensions';
    const hasBase64 =
        typeof response.base64 === 'string' ||
        typeof response.screenshotBase64 === 'string' ||
        typeof response.screenshot_base64 === 'string' ||
        typeof response.dataUrl === 'string' ||
        typeof response.data_url === 'string';

    if (path) {
        const name = path.split(/[\\/]/).pop() || 'browser-screenshot.png';
        return {
            result: [
                '<browser_screenshot>',
                url ? `url: ${redactUrl(url)}` : null,
                `attachment: ${name}`,
                `markdown: ${formatScreenshotMarkdown(name, url)}`,
                `mimeType: ${mimeType}`,
                `dimensions: ${dimensions}`,
                hasBase64 ? 'base64 suppressed from model-visible result' : null,
                '</browser_screenshot>',
            ]
                .filter(Boolean)
                .join('\n'),
            attachments: [
                {
                    id: `browser-screenshot-${Date.now()}`,
                    type: 'image',
                    path,
                    originPath: path,
                    name,
                    mimeType,
                    supportStatus: 'supported',
                },
            ],
        };
    }

    return {
        result: [
            '<browser_screenshot>',
            url ? `url: ${redactUrl(url)}` : null,
            `mimeType: ${mimeType}`,
            `dimensions: ${dimensions}`,
            hasBase64
                ? 'artifact: screenshot captured; base64 suppressed from model-visible result'
                : 'artifact: screenshot metadata returned without local path',
            '</browser_screenshot>',
        ].join('\n'),
    };
}

export function formatBrowserToolResult(
    operation: string,
    response: unknown
): {
    result: string;
    attachments?: AttachmentIndex[];
} {
    if (operation === 'screenshot' && isRecord(response)) {
        return formatScreenshotResponse(response);
    }

    const result = formatRedactedJson(stripScreenshotPayloads(response));
    return {
        result: truncateText(result, 20000),
    };
}

export function formatBrowserToolError(error: unknown): string {
    const message = error instanceof Error ? error.message : String(error);
    return String(redactBrowserValue(message));
}

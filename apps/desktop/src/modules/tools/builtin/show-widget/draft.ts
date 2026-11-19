// Copyright (c) 2026. 千诚. Licensed under GPL v3

import type { ShowWidgetEventPayload, ShowWidgetMode } from '../../contracts/events';
import type { ToolMessages } from '../../contracts/host';

interface ShowWidgetDraft {
    widgetId?: string;
    title?: string;
    description?: string;
    html?: string;
    mode?: ShowWidgetMode;
}

export function createWidgetDrafts(messages: ToolMessages) {
    const tt = messages.tt.bind(messages);
    function readPartialJsonStringField(buffer: string, fieldName: string): string | undefined {
        const marker = `"${fieldName}"`;
        const markerIndex = buffer.indexOf(marker);
        if (markerIndex < 0) {
            return undefined;
        }

        const colonIndex = buffer.indexOf(':', markerIndex + marker.length);
        if (colonIndex < 0) {
            return undefined;
        }

        let cursor = colonIndex + 1;
        while (cursor < buffer.length && /\s/.test(buffer[cursor]!)) {
            cursor += 1;
        }

        if (buffer[cursor] !== '"') {
            return undefined;
        }

        cursor += 1;
        let value = '';
        let escaping = false;

        while (cursor < buffer.length) {
            const char = buffer[cursor]!;
            cursor += 1;

            if (escaping) {
                if (char === 'u') {
                    const unicode = buffer.slice(cursor, cursor + 4);
                    if (/^[0-9a-fA-F]{4}$/.test(unicode)) {
                        value += String.fromCharCode(Number.parseInt(unicode, 16));
                        cursor += 4;
                    } else {
                        value += '\\u';
                    }
                } else if (char === 'n') {
                    value += '\n';
                } else if (char === 'r') {
                    value += '\r';
                } else if (char === 't') {
                    value += '\t';
                } else {
                    value += char;
                }

                escaping = false;
                continue;
            }

            if (char === '\\') {
                escaping = true;
                continue;
            }

            if (char === '"') {
                return value;
            }

            value += char;
        }

        return value;
    }

    function readPartialJsonEnumField<T extends readonly string[]>(
        buffer: string,
        fieldName: string,
        allowedValues: T
    ): T[number] | undefined {
        const rawValue = readPartialJsonStringField(buffer, fieldName);
        if (!rawValue || !allowedValues.includes(rawValue as T[number])) {
            return undefined;
        }

        return rawValue as T[number];
    }

    /**
     * 从仍在流式生成的工具参数里提取 ShowWidget 草稿。
     *
     * @param callId 工具调用 id。
     * @param argumentsBuffer provider 当前已经输出的参数缓冲。
     * @returns 可立即渲染的 draft payload；如果还没有任何关键信息则返回 `null`。
     */
    function buildShowWidgetDraftFromArgumentsBuffer(
        callId: string,
        argumentsBuffer: string
    ): ShowWidgetEventPayload | null {
        const widgetCode =
            readPartialJsonStringField(argumentsBuffer, 'widget_code') ??
            readPartialJsonStringField(argumentsBuffer, 'html');
        const draft: ShowWidgetDraft = {
            mode: readPartialJsonEnumField(argumentsBuffer, 'mode', ['render', 'remove'] as const),
            widgetId: readPartialJsonStringField(argumentsBuffer, 'widgetId'),
            title: readPartialJsonStringField(argumentsBuffer, 'title'),
            description: readPartialJsonStringField(argumentsBuffer, 'description'),
            html: widgetCode,
        };

        if (!draft.widgetId && !draft.title && !draft.html) {
            return null;
        }

        return {
            callId,
            widgetId: draft.widgetId || callId,
            title: draft.title || draft.widgetId || tt('生成中的可视化'),
            description: draft.description || tt('模型正在按已加载规范流式生成内联可视化内容。'),
            html: draft.html || '',
            mode: draft.mode || 'render',
            phase: 'draft',
        };
    }

    return Object.freeze({ build: buildShowWidgetDraftFromArgumentsBuffer });
}

// Copyright (c) 2026. 千诚. Licensed under GPL v3

import {
    BuiltInTool,
    type BuiltInToolConversationSemantic,
    type BuiltInToolExecutionResult,
    type BuiltInToolGroup,
} from '../../types';
import { MEMORY_TOOL_DESCRIPTION, MEMORY_TOOL_INPUT_SCHEMA } from './constants';
import {
    buildMemoryApprovalRequest,
    executeMemoryTool,
    parseMemoryRequest,
    prepareMemoryToolArgs,
    sanitizeMemoryLogInput,
} from './helper';

function buildMemoryConversationSemantic(
    args: Record<string, unknown>
): BuiltInToolConversationSemantic {
    try {
        const request = parseMemoryRequest(args);
        if (request.action === 'read') {
            const items = request.ids.map((id) => String(id));
            return {
                action: 'read',
                target: items.join(', '),
                presentationHint: {
                    kind: 'memory' as const,
                    items,
                },
            };
        }
        if (request.action === 'delete') {
            return {
                action: 'remove',
                target: String(request.id),
                presentationHint: {
                    kind: 'memory' as const,
                    items: [String(request.id)],
                },
            };
        }
        return { action: 'update', target: request.title };
    } catch {
        return {
            action: 'process',
            presentationHint: {
                kind: 'memory' as const,
                items: [],
            },
        };
    }
}

function parseMemoryReadTitlesFromResult(result: string): string[] {
    const titles: string[] = [];
    const titlePattern = /^\s*title_untrusted:\s*(.+?)\s*$/gm;
    let match: RegExpExecArray | null;

    while ((match = titlePattern.exec(result)) !== null) {
        const rawTitle = match[1]?.trim();
        if (!rawTitle) {
            continue;
        }

        try {
            const parsed = JSON.parse(rawTitle) as unknown;
            if (typeof parsed === 'string' && parsed.trim()) {
                titles.push(parsed.trim());
            }
        } catch {
            if (rawTitle) {
                titles.push(rawTitle);
            }
        }
    }

    return titles;
}

class MemoryTool extends BuiltInTool<Record<string, never>> {
    readonly id = 'memory' as const;
    readonly displayName = 'Memory';
    readonly description = MEMORY_TOOL_DESCRIPTION;
    readonly inputSchema = MEMORY_TOOL_INPUT_SCHEMA;
    readonly defaultConfig = {};

    override buildConversationSemantic(args: Record<string, unknown>) {
        return buildMemoryConversationSemantic(args);
    }

    override buildConversationSemanticFromResult(result: string, args: Record<string, unknown>) {
        let request: ReturnType<typeof parseMemoryRequest>;
        try {
            request = parseMemoryRequest(args);
        } catch {
            return null;
        }

        if (request.action !== 'read') {
            return null;
        }

        const titles = parseMemoryReadTitlesFromResult(result);
        if (titles.length === 0) {
            return null;
        }

        return {
            action: 'read' as const,
            target: titles.join(', '),
            presentationHint: {
                kind: 'memory' as const,
                items: titles,
            },
        };
    }

    override buildApprovalRequest(args: Record<string, unknown>) {
        return buildMemoryApprovalRequest(args);
    }

    override prepareForExecution(args: Record<string, unknown>): Record<string, unknown> {
        return prepareMemoryToolArgs(args);
    }

    override sanitizeLogInput(args: Record<string, unknown>): Record<string, unknown> {
        return sanitizeMemoryLogInput(args);
    }

    override execute(args: Record<string, unknown>): Promise<BuiltInToolExecutionResult> {
        return executeMemoryTool(args);
    }
}

export const memoryTool = new MemoryTool();
export const builtInTools: BuiltInToolGroup = [memoryTool];

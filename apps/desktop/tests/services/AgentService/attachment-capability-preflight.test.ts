import type { MessageRow, ToolLogHistoryRow } from '@database/queries/messages';
import type { ModelWithProvider } from '@database/queries/models';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import { AiErrorCode } from '@/services/AgentService/contracts/errors';
import { AiConversationRuntime } from '@/services/AgentService/execution/runtime';
import type { AttachmentIndex } from '@/services/AgentService/infrastructure/attachments';
import {
    getModelAttachmentCapabilities,
    getUnsupportedAttachmentTypes,
} from '@/services/AgentService/infrastructure/attachments';
import { findUnsupportedSessionAttachmentTypes } from '@/services/AgentService/session/transport';

const BASE_TIME = '2026-06-03T10:00:00.000Z';

const mocks = vi.hoisted(() => ({
    findMessagesBySessionId: vi.fn<() => Promise<MessageRow[]>>(),
    findToolLogRowsBySessionId: vi.fn<() => Promise<ToolLogHistoryRow[]>>(),
}));

vi.mock('@database/queries/messages', async (importOriginal) => {
    const actual = await importOriginal<typeof import('@database/queries/messages')>();

    return {
        ...actual,
        findMessagesBySessionId: mocks.findMessagesBySessionId,
        findToolLogRowsBySessionId: mocks.findToolLogRowsBySessionId,
    };
});

function createAttachment(overrides: Partial<AttachmentIndex> = {}): AttachmentIndex {
    const type = overrides.type ?? 'image';
    return {
        id: `attachment-${type}`,
        type,
        path: `D:/attachments/${type}`,
        originPath: `D:/attachments/${type}`,
        name: `${type}.dat`,
        ...overrides,
    };
}

function createMessageAttachment(type: 'image' | 'file') {
    return {
        message_id: type === 'image' ? 10 : 11,
        sort_order: 0,
        id: type === 'image' ? 1 : 2,
        hash: `hash-${type}`,
        type,
        original_name: `${type}.dat`,
        origin_path: `D:/attachments/${type}`,
        mime_type: type === 'image' ? 'image/png' : 'application/pdf',
        size: 10,
        created_at: BASE_TIME,
    };
}

function createMessageRow(overrides: Partial<MessageRow>): MessageRow {
    return {
        id: 1,
        session_id: 1,
        role: 'user',
        content: '',
        reasoning: null,
        attachments: [],
        tool_call_id: null,
        tool_name: null,
        tool_input: null,
        tool_log_ref_id: null,
        tool_status: null,
        tool_duration_ms: null,
        server_id: null,
        tool_log_id: null,
        tool_log_kind: null,
        created_at: BASE_TIME,
        updated_at: BASE_TIME,
        ...overrides,
    };
}

function createModel(overrides: Partial<ModelWithProvider> = {}): ModelWithProvider {
    return {
        id: 1,
        created_at: BASE_TIME,
        updated_at: BASE_TIME,
        provider_id: 1,
        model_id: 'text-only',
        name: 'Text Only',
        is_default: 1,
        last_used_at: null,
        attachment: 0,
        modalities: JSON.stringify({ input: ['text'], output: ['text'] }),
        open_weights: 0,
        reasoning: 1,
        release_date: null,
        temperature: 1,
        tool_call: 1,
        knowledge: null,
        context_limit: null,
        output_limit: null,
        is_custom_metadata: 0,
        provider_name: 'Test Provider',
        provider_driver: 'openai',
        api_endpoint: 'https://example.test',
        api_key: null,
        provider_config_json: null,
        provider_enabled: 1,
        provider_logo: '',
        ...overrides,
    };
}

describe('AgentService attachment capability preflight', () => {
    beforeEach(() => {
        mocks.findMessagesBySessionId.mockReset();
        mocks.findToolLogRowsBySessionId.mockReset();
        mocks.findToolLogRowsBySessionId.mockResolvedValue([]);
    });

    it('derives image and file support from model metadata independently', () => {
        expect(
            getModelAttachmentCapabilities({
                modalities: JSON.stringify({ input: ['text', 'image'], output: ['text'] }),
                attachment: 0,
            })
        ).toEqual({ supportsImages: true, supportsFiles: false });

        expect(
            getModelAttachmentCapabilities({
                modalities: JSON.stringify({ input: ['text'], output: ['text'] }),
                attachment: 1,
            })
        ).toEqual({ supportsImages: false, supportsFiles: true });
    });

    it('detects unsupported current attachments without reading attachment content', () => {
        expect(
            getUnsupportedAttachmentTypes(
                [createAttachment({ type: 'image' }), createAttachment({ type: 'file' })],
                { supportsImages: false, supportsFiles: true }
            )
        ).toEqual(['image']);
    });

    it('detects unsupported historical user and tool-result attachments before transport build', async () => {
        mocks.findMessagesBySessionId.mockResolvedValue([
            createMessageRow({
                id: 10,
                role: 'user',
                content: 'image from history',
                attachments: [createMessageAttachment('image')],
            }),
            createMessageRow({
                id: 11,
                role: 'tool_result',
                content: 'file returned by tool',
                attachments: [createMessageAttachment('file')],
            }),
            createMessageRow({
                id: 12,
                role: 'assistant',
                content: 'ignored assistant attachment metadata',
                attachments: [createMessageAttachment('image')],
            }),
        ]);

        await expect(
            findUnsupportedSessionAttachmentTypes({
                sessionId: 1,
                capabilities: { supportsImages: false, supportsFiles: false },
            })
        ).resolves.toEqual(['image', 'file']);
    });

    it('fails a runtime before the first model attempt when history has unsupported attachments', async () => {
        mocks.findMessagesBySessionId.mockResolvedValue([
            createMessageRow({
                id: 10,
                role: 'user',
                content: 'image from history',
                attachments: [createMessageAttachment('image')],
            }),
        ]);

        const runAttempt = vi.fn();
        const runtime = new AiConversationRuntime(
            {
                getModel: vi.fn().mockResolvedValue(createModel()),
                runAttempt,
            } as unknown as ConstructorParameters<typeof AiConversationRuntime>[0],
            {
                prompt: 'continue',
                sessionId: 1,
            }
        );

        await expect(runtime.run()).rejects.toMatchObject({
            code: AiErrorCode.UNSUPPORTED_INPUT,
        });
        expect(runAttempt).not.toHaveBeenCalled();
    });
});

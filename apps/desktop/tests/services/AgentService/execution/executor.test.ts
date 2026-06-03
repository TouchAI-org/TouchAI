import { beforeEach, describe, expect, it, vi } from 'vitest';

import { AiError, AiErrorCode } from '@/services/AgentService/contracts/errors';
import { AiRequestExecutor } from '@/services/AgentService/execution';
import type { AttemptCheckpoint } from '@/services/AgentService/execution/executor';

const providerMock = vi.hoisted(() => ({
    stream: vi.fn(),
    classifyError: vi.fn(),
}));

vi.mock('@/services/AgentService/catalog', () => ({
    createProviderForModel: vi.fn(() => providerMock),
    resolveToolDefinitions: vi.fn(() => Promise.resolve([])),
    getModel: vi.fn(),
}));

function createCheckpoint(): AttemptCheckpoint {
    return {
        activeModel: {
            id: 1,
            created_at: '',
            updated_at: '',
            provider_id: 12,
            model_id: 'mimo-v2.5',
            name: 'mimo-v2.5',
            is_default: 1,
            last_used_at: null,
            attachment: 0,
            modalities: null,
            open_weights: 0,
            reasoning: 0,
            release_date: null,
            temperature: 1,
            tool_call: 0,
            knowledge: null,
            context_limit: null,
            output_limit: null,
            is_custom_metadata: 0,
            provider_name: 'Xiaomi MiMo',
            provider_driver: 'mimo',
            api_endpoint: 'https://hub.touch-ai.org/api/v1',
            api_key: 'ta_live_test',
            provider_config_json: '{"touchAiMode":"managed"}',
            provider_enabled: 1,
            provider_logo: '',
        },
        messages: [{ role: 'user', content: 'hello' }],
        response: '',
        reasoning: '',
        iteration: 0,
        modelSwitchCount: 0,
        modelLanguageContext: { locale: 'zh-CN', label: 'Simplified Chinese' },
        executedBuiltInToolIds: [],
    };
}

describe('AiRequestExecutor', () => {
    beforeEach(() => {
        vi.clearAllMocks();
    });

    it('keeps the original request error when provider error classification fails', async () => {
        const requestError = new Error(
            'error sending request for url (https://hub.touch-ai.org/api/v1/chat/completions)'
        );
        providerMock.stream.mockImplementation(async function* () {
            throw requestError;
        });
        providerMock.classifyError.mockImplementation(() => {
            throw new TypeError('n is not a function');
        });

        const executor = new AiRequestExecutor();
        const result = await executor.runAttempt({
            startCheckpoint: createCheckpoint(),
            persister: {} as never,
        });

        expect(result.type).toBe('failed');
        if (result.type !== 'failed') {
            return;
        }
        expect(providerMock.classifyError).toHaveBeenCalledWith(requestError);
        expect(result.error.code).toBe(AiErrorCode.NETWORK_ERROR);
        expect(result.error.message).toBe(AiError.getMessage(AiErrorCode.NETWORK_ERROR));
        expect(result.error.cause).toBe(requestError);
        expect(result.error.details).toBe(requestError);
    });
});

import { createModels } from '@touchai/models';
import type { AiProviderConfig, ModelsHost } from '@touchai/models/contracts';
import { OpenAICompatibleProviderAdapter } from '@touchai/models/providers/openai-compatible';

export function createTestModelsHost(fetch: typeof globalThis.fetch): ModelsHost {
    return {
        fetch,
        remoteRefs: {
            read: async () => null,
            touch: async () => undefined,
            write: async () => undefined,
        },
    };
}

export function createCompatibleProvider(
    fetch: typeof globalThis.fetch,
    config: Partial<AiProviderConfig> = {}
) {
    return createModels({
        providers: [
            {
                driver: 'openai-compatible',
                create: (profile, io) => new OpenAICompatibleProviderAdapter(profile, io),
            },
        ],
    }).createConnection({
        driver: 'openai-compatible',
        host: createTestModelsHost(fetch),
        config: { apiEndpoint: 'https://api.example.com/v1/', apiKey: '  secret  ', ...config },
    });
}

export function compatibleResponse(content = 'fixture answer'): Response {
    return new Response(
        `data: ${JSON.stringify({ id: 'fixture', created: 1, model: 'fixture', choices: [{ index: 0, delta: { content }, finish_reason: 'stop' }] })}\n\ndata: [DONE]\n\n`,
        { headers: { 'content-type': 'text/event-stream' } }
    );
}

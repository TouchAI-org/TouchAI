import type { ModelWithProvider } from '@database/queries/models';
import { describe, expect, it } from 'vitest';

import { AgentService } from '@/services/AgentService';
import snapshot from '@/services/AgentService/infrastructure/modelMetadata/snapshot.json';

const sol = snapshot.models['openai/gpt-6-sol'];

const model = {
    id: 1,
    created_at: '',
    updated_at: '',
    provider_id: 1,
    model_id: sol.id,
    name: sol.name,
    is_default: 1,
    last_used_at: null,
    attachment: 0,
    modalities: null,
    open_weights: 0,
    reasoning: 1,
    reasoning_options: JSON.stringify(sol.reasoning_options),
    release_date: null,
    temperature: 1,
    tool_call: 1,
    knowledge: null,
    context_limit: null,
    output_limit: null,
    is_custom_metadata: 0,
    upstream_metadata: null,
    provider_name: 'OpenAI',
    provider_driver: 'openai',
    api_endpoint: 'https://api.openai.com/v1',
    api_key: null,
    provider_config_json: JSON.stringify({
        reasoning: { format: 'openai', mode: 'passthrough' },
    }),
    provider_enabled: 1,
    provider_logo: '',
} satisfies ModelWithProvider;

describe('given a request using OpenAI Chat with GPT-6 Sol', () => {
    const service = new AgentService();

    it('user without enabled tools can choose its supported reasoning depths', () => {
        const levels = service.getModelReasoningLevels(model, { hasTools: false });

        expect(levels).toContain('high');
        expect(levels).not.toEqual(['off']);
    });

    it('user with enabled tools is limited to the depth that supports function calling', () => {
        expect(service.getModelReasoningLevels(model, { hasTools: true })).toEqual(['off']);
    });
});

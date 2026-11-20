import { createModels, type ProviderRegistration } from '@touchai/models';
import { AlibabaProviderAdapter } from '@touchai/models/providers/alibaba';
import { AnthropicProviderAdapter } from '@touchai/models/providers/anthropic';
import { AnthropicCompatibleProviderAdapter } from '@touchai/models/providers/anthropic-compatible';
import { DeepSeekProviderAdapter } from '@touchai/models/providers/deepseek';
import { GoogleProviderAdapter } from '@touchai/models/providers/google';
import { MiMoProviderAdapter } from '@touchai/models/providers/mimo';
import { MiniMaxProviderAdapter } from '@touchai/models/providers/minimax';
import { MoonshotProviderAdapter } from '@touchai/models/providers/moonshot';
import { OpenAIProviderAdapter } from '@touchai/models/providers/openai';
import { OpenAICompatibleProviderAdapter } from '@touchai/models/providers/openai-compatible';
import { XaiProviderAdapter } from '@touchai/models/providers/xai';
import { ZhipuProviderAdapter } from '@touchai/models/providers/zhipu';

export function createProviderRegistry() {
    const providers: readonly ProviderRegistration[] = [
        { driver: 'openai', create: (config, host) => new OpenAIProviderAdapter(config, host) },
        {
            driver: 'openai-compatible',
            create: (config, host) => new OpenAICompatibleProviderAdapter(config, host),
        },
        {
            driver: 'anthropic',
            create: (config, host) => new AnthropicProviderAdapter(config, host),
        },
        {
            driver: 'anthropic-compatible',
            create: (config, host) => new AnthropicCompatibleProviderAdapter(config, host),
        },
        { driver: 'google', create: (config, host) => new GoogleProviderAdapter(config, host) },
        { driver: 'deepseek', create: (config, host) => new DeepSeekProviderAdapter(config, host) },
        { driver: 'xai', create: (config, host) => new XaiProviderAdapter(config, host) },
        { driver: 'moonshot', create: (config, host) => new MoonshotProviderAdapter(config, host) },
        { driver: 'alibaba', create: (config, host) => new AlibabaProviderAdapter(config, host) },
        { driver: 'minimax', create: (config, host) => new MiniMaxProviderAdapter(config, host) },
        { driver: 'zhipu', create: (config, host) => new ZhipuProviderAdapter(config, host) },
        { driver: 'mimo', create: (config, host) => new MiMoProviderAdapter(config, host) },
    ];
    return createModels({ providers });
}

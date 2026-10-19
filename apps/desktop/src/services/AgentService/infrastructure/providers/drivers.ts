// Copyright (c) 2026. Qian Cheng. Licensed under GPL v3

import type { ProviderDriver } from '@database/schema';

import { AlibabaProviderAdapter } from './adapters/alibaba';
import { AnthropicProviderAdapter } from './adapters/anthropic';
import { AnthropicCompatibleProviderAdapter } from './adapters/anthropic-compatible';
import { DeepSeekProviderAdapter } from './adapters/deepseek';
import { GoogleProviderAdapter } from './adapters/google';
import { MiMoProviderAdapter } from './adapters/mimo';
import { MiniMaxProviderAdapter } from './adapters/minimax';
import { MoonshotProviderAdapter } from './adapters/moonshot';
import { OpenAIProviderAdapter } from './adapters/openai';
import { OpenAICompatibleProviderAdapter } from './adapters/openai-compatible';
import { XaiProviderAdapter } from './adapters/xai';
import { ZhipuProviderAdapter } from './adapters/zhipu';
import { isProviderDriver } from './driverCatalog';
import type { AiProvider, AiProviderConfig } from './types';

/**
 * Provider driver 实例化入口。
 *
 * 这里会静态导入全部厂商 adapter：只有真正发起请求的代码才应引用本模块。
 * 设置页/展示层的元信息请从 `driverCatalog` 读取，避免把 SDK 拉进首屏。
 * 展示定义与校验函数从 `driverCatalog` 重新导出，保持既有导入路径可用。
 */
export {
    getProviderDriverDefinition,
    getProviderDriverDefinitions,
    isProviderDriver,
    parseProviderDriver,
    providerDriverDefinitions,
    type ProviderDriverDefinition,
} from './driverCatalog';

const providerFactories: Record<ProviderDriver, (config: AiProviderConfig) => AiProvider> = {
    openai: (config) => new OpenAIProviderAdapter(config),
    'openai-compatible': (config) => new OpenAICompatibleProviderAdapter(config),
    anthropic: (config) => new AnthropicProviderAdapter(config),
    'anthropic-compatible': (config) => new AnthropicCompatibleProviderAdapter(config),
    google: (config) => new GoogleProviderAdapter(config),
    deepseek: (config) => new DeepSeekProviderAdapter(config),
    xai: (config) => new XaiProviderAdapter(config),
    moonshot: (config) => new MoonshotProviderAdapter(config),
    alibaba: (config) => new AlibabaProviderAdapter(config),
    minimax: (config) => new MiniMaxProviderAdapter(config),
    zhipu: (config) => new ZhipuProviderAdapter(config),
    mimo: (config) => new MiMoProviderAdapter(config),
};

/**
 * 通过 driver 注册表创建对应的 provider 实例。
 */
export function createProviderFromRegistry(
    driver: ProviderDriver,
    config: AiProviderConfig
): AiProvider {
    if (!isProviderDriver(driver)) {
        throw new Error(`Unknown provider driver: ${String(driver)}`);
    }

    return providerFactories[driver](config);
}

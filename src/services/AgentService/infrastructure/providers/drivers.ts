// Copyright (c) 2026. Qian Cheng. Licensed under GPL v3

import type { ProviderDriver } from '@database/schema';

import { AlibabaProviderAdapter } from './adapters/alibaba';
import { AnthropicProviderAdapter } from './adapters/anthropic';
import { DeepSeekProviderAdapter } from './adapters/deepseek';
import { GoogleProviderAdapter } from './adapters/google';
import { MiniMaxProviderAdapter } from './adapters/minimax';
import { MoonshotProviderAdapter } from './adapters/moonshot';
import { OpenAIProviderAdapter } from './adapters/openai';
import { XaiProviderAdapter } from './adapters/xai';
import { ZhipuProviderAdapter } from './adapters/zhipu';
import type { AiProvider, AiProviderConfig } from './types';

export interface ProviderDriverDefinition {
    driver: ProviderDriver;
    label: string;
    logo: string;
    placeholder: string;
}

interface ProviderDriverEntry extends ProviderDriverDefinition {
    create: (config: AiProviderConfig) => AiProvider;
}

/**
 * Provider driver 的统一注册表：
 * 同时承载设置页展示元信息与运行时实例化入口。
 */
const providerDrivers: ProviderDriverEntry[] = [
    {
        driver: 'openai',
        label: 'OpenAI',
        logo: 'openai.png',
        placeholder: 'https://api.openai.com',
        create: (config) => new OpenAIProviderAdapter(config),
    },
    {
        driver: 'anthropic',
        label: 'Anthropic',
        logo: 'anthropic.png',
        placeholder: 'https://api.anthropic.com',
        create: (config) => new AnthropicProviderAdapter(config),
    },
    {
        driver: 'google',
        label: 'Google',
        logo: 'gemini.png',
        placeholder: 'https://generativelanguage.googleapis.com',
        create: (config) => new GoogleProviderAdapter(config),
    },
    {
        driver: 'deepseek',
        label: 'DeepSeek',
        logo: 'deepseek.png',
        placeholder: 'https://api.deepseek.com',
        create: (config) => new DeepSeekProviderAdapter(config),
    },
    {
        driver: 'xai',
        label: 'xAI',
        logo: 'grok.png',
        placeholder: 'https://api.x.ai',
        create: (config) => new XaiProviderAdapter(config),
    },
    {
        driver: 'moonshot',
        label: 'Moonshot',
        logo: 'moonshot.png',
        placeholder: 'https://api.moonshot.ai/v1',
        create: (config) => new MoonshotProviderAdapter(config),
    },
    {
        driver: 'alibaba',
        label: '阿里云百炼',
        logo: 'bailian.png',
        placeholder: 'https://dashscope.aliyuncs.com/compatible-mode/v1',
        create: (config) => new AlibabaProviderAdapter(config),
    },
    {
        driver: 'minimax',
        label: 'MiniMax',
        logo: 'minimax.png',
        placeholder: 'https://api.minimax.io/anthropic/v1',
        create: (config) => new MiniMaxProviderAdapter(config),
    },
    {
        driver: 'zhipu',
        label: '智谱',
        logo: 'zhipu.png',
        placeholder: 'https://open.bigmodel.cn/api/paas/v4',
        create: (config) => new ZhipuProviderAdapter(config),
    },
];

const providerDriverSet = new Set<string>(providerDrivers.map((entry) => entry.driver));

/**
 * 所有 driver 的展示定义列表。
 */
export const providerDriverDefinitions: ProviderDriverDefinition[] = providerDrivers.map(
    (entry) => ({
        driver: entry.driver,
        label: entry.label,
        logo: entry.logo,
        placeholder: entry.placeholder,
    })
);

export function isProviderDriver(value: unknown): value is ProviderDriver {
    return typeof value === 'string' && providerDriverSet.has(value);
}

export function parseProviderDriver(value: unknown): ProviderDriver {
    if (!isProviderDriver(value)) {
        throw new Error(`Unknown provider driver: ${String(value)}`);
    }

    return value;
}

function getProviderDriverEntry(driver: ProviderDriver): ProviderDriverEntry {
    const entry = providerDrivers.find((item) => item.driver === driver);
    if (!entry) {
        throw new Error(`Unknown provider driver: ${driver}`);
    }
    return entry;
}

/**
 * 按驱动读取对应的展示元信息。
 */
export function getProviderDriverDefinition(driver: ProviderDriver): ProviderDriverDefinition {
    const entry = getProviderDriverEntry(driver);
    return {
        driver: entry.driver,
        label: entry.label,
        logo: entry.logo,
        placeholder: entry.placeholder,
    };
}

/**
 * 通过 driver 注册表创建对应的 provider 实例。
 */
export function createProviderFromRegistry(
    driver: ProviderDriver,
    config: AiProviderConfig
): AiProvider {
    return getProviderDriverEntry(driver).create(config);
}

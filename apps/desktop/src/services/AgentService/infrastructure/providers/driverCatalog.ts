// Copyright (c) 2026. Qian Cheng. Licensed under GPL v3

import type { ProviderDriver } from '@database/schema';

import { tt } from '@/i18n';

import { MIMO_API_BASE_URL } from './config';

/**
 * Provider driver 展示目录。
 *
 * 这里只包含设置页/展示层需要的元信息与校验函数，**不导入任何厂商 adapter**。
 * 这样可以避免"打开设置页或初始化模型元数据"时把全部 provider SDK 拉进内存。
 * 真正的实例化入口在 `drivers.ts`。
 */
export interface ProviderDriverDefinition {
    driver: ProviderDriver;
    label: string;
    logo: string;
    placeholder: string;
}

export const PROVIDER_DRIVER_METADATA: readonly ProviderDriverDefinition[] = [
    {
        driver: 'openai',
        label: 'OpenAI',
        logo: 'openai.png',
        placeholder: 'https://api.openai.com',
    },
    {
        driver: 'openai-compatible',
        label: 'OpenAI 兼容',
        logo: 'openai.png',
        placeholder: 'https://api.example.com/v1',
    },
    {
        driver: 'anthropic',
        label: 'Anthropic',
        logo: 'anthropic.png',
        placeholder: 'https://api.anthropic.com',
    },
    {
        driver: 'anthropic-compatible',
        label: 'Anthropic 兼容',
        logo: 'anthropic.png',
        placeholder: 'https://api.example.com',
    },
    {
        driver: 'google',
        label: 'Google',
        logo: 'gemini.png',
        placeholder: 'https://generativelanguage.googleapis.com',
    },
    {
        driver: 'deepseek',
        label: 'DeepSeek',
        logo: 'deepseek.png',
        placeholder: 'https://api.deepseek.com',
    },
    {
        driver: 'xai',
        label: 'xAI',
        logo: 'grok.png',
        placeholder: 'https://api.x.ai',
    },
    {
        driver: 'moonshot',
        label: 'Moonshot',
        logo: 'moonshot.png',
        placeholder: 'https://api.moonshot.ai/v1',
    },
    {
        driver: 'alibaba',
        label: '阿里云百炼',
        logo: 'bailian.png',
        placeholder: 'https://dashscope.aliyuncs.com/compatible-mode/v1',
    },
    {
        driver: 'minimax',
        label: 'MiniMax',
        logo: 'minimax.png',
        placeholder: 'https://api.minimax.io/anthropic/v1',
    },
    {
        driver: 'zhipu',
        label: '智谱',
        logo: 'zhipu.png',
        placeholder: 'https://open.bigmodel.cn/api/paas/v4',
    },
    {
        driver: 'mimo',
        label: 'Xiaomi MiMo',
        logo: 'mimo.png',
        placeholder: MIMO_API_BASE_URL,
    },
];

const providerDriverSet = new Set<string>(PROVIDER_DRIVER_METADATA.map((entry) => entry.driver));

/**
 * 所有 driver 的展示定义列表。
 */
export function getProviderDriverDefinitions(): ProviderDriverDefinition[] {
    return PROVIDER_DRIVER_METADATA.map((entry) => ({
        driver: entry.driver,
        label: tt(entry.label),
        logo: entry.logo,
        placeholder: entry.placeholder,
    }));
}

export const providerDriverDefinitions: ProviderDriverDefinition[] = new Proxy(
    [] as ProviderDriverDefinition[],
    {
        get(_target, property) {
            const definitions = getProviderDriverDefinitions();
            const value = Reflect.get(definitions, property);
            return typeof value === 'function' ? value.bind(definitions) : value;
        },
        has(_target, property) {
            return property in getProviderDriverDefinitions();
        },
    }
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

/**
 * 按驱动读取对应的展示元信息。
 */
export function getProviderDriverDefinition(driver: ProviderDriver): ProviderDriverDefinition {
    const entry = PROVIDER_DRIVER_METADATA.find((item) => item.driver === driver);
    if (!entry) {
        throw new Error(`Unknown provider driver: ${driver}`);
    }

    return {
        driver: entry.driver,
        label: tt(entry.label),
        logo: entry.logo,
        placeholder: entry.placeholder,
    };
}

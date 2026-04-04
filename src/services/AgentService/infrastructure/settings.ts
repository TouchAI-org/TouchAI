// Copyright (c) 2026. Qian Cheng. Licensed under GPL v3

import { getSettingValue } from '@database/queries';
import { SettingKey } from '@database/schema';

const DEFAULT_MCP_MAX_ITERATIONS = 10;
const MCP_MAX_ITERATIONS_SETTING_KEY = SettingKey.MCP_MAX_ITERATIONS;

function normalizeMcpMaxIterations(value: number): number {
    if (Number.isNaN(value)) {
        return DEFAULT_MCP_MAX_ITERATIONS;
    }

    return Math.max(1, Math.min(50, value));
}

/**
 * 读取 Agent 运行时需要的迭代上限配置。
 *
 * 这里直接从数据库设置读取，避免执行层依赖页面 store。
 */
export async function resolveMcpMaxIterations(): Promise<number> {
    try {
        const rawValue = await getSettingValue({ key: MCP_MAX_ITERATIONS_SETTING_KEY });
        const parsedValue = rawValue ? parseInt(rawValue, 10) : Number.NaN;
        return normalizeMcpMaxIterations(parsedValue);
    } catch (error) {
        console.error(
            `[AgentRuntimeSettings] Failed to load ${MCP_MAX_ITERATIONS_SETTING_KEY}:`,
            error
        );
        return DEFAULT_MCP_MAX_ITERATIONS;
    }
}

// Copyright (c) 2026. 千诚. Licensed under GPL v3.

/**
 * 启动能力就绪注册表。
 *
 * 启动分阶段：语言/窗口策略就绪后立即挂载外壳，工具补种、Bash 预热、模型元数据同步
 * 转为后台能力。用户提前发请求时，请求层只等待实际依赖的能力，而不是等整个启动流程。
 *
 * 能力是「尽力而为」：单个能力失败只记录警告，不阻塞请求。
 */

import { log } from '@services/ObservabilityService';

export type StartupCapabilityName = 'built-in-tools' | 'built-in-bash' | 'model-metadata';

/** Agent 请求启动前必须就绪的能力集合。 */
export const AGENT_STARTUP_CAPABILITIES: readonly StartupCapabilityName[] = [
    'built-in-tools',
    'built-in-bash',
    'model-metadata',
];

const settledCapabilities = new Map<string, Promise<void>>();

export function registerStartupCapability(name: string, task: Promise<unknown>): void {
    const settled = task
        .then(() => undefined)
        .catch((error: unknown) => {
            log.warn(`[StartupService] Capability "${name}" failed to initialize:`, error);
        });

    settledCapabilities.set(name, settled);
}

export function isStartupCapabilityRegistered(name: string): boolean {
    return settledCapabilities.has(name);
}

/** 未注册的能力视为已就绪（轻量窗口、设置页不注册这些能力）。 */
export function whenStartupCapabilityReady(name: string): Promise<void> {
    return settledCapabilities.get(name) ?? Promise.resolve();
}

export async function waitForAgentStartupCapabilities(): Promise<void> {
    await Promise.all(AGENT_STARTUP_CAPABILITIES.map((name) => whenStartupCapabilityReady(name)));
}

/** 仅测试使用：清空注册表。 */
export function resetStartupCapabilities(): void {
    settledCapabilities.clear();
}

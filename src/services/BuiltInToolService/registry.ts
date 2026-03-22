// Copyright (c) 2026. 千诚. Licensed under GPL v3

import { builtInTools as bashTools } from './tools/bash';
import { builtInTools as fileSearchTools } from './tools/fileSearch';
import { builtInTools as settingTools } from './tools/setting';
import { builtInTools as upgradeModelTools } from './tools/upgradeModel';
import { builtInTools as webFetchTools } from './tools/webFetch';
import { builtInTools as widgetToolTools } from './tools/widgetTool';
import type { BuiltInTool, BuiltInToolGroup, BuiltInToolId } from './types';

/**
 * 内置工具注册表。
 */
class BuiltInToolRegistry {
    private readonly tools = new Map<BuiltInToolId, BuiltInTool>();

    /**
     * 注册一个内置工具，或同目录导出的一组工具。
     *
     * @param toolOrTools 单个工具实例，或工具实例数组。
     * @returns 无。
     */
    register(toolOrTools: BuiltInTool | BuiltInToolGroup): void {
        const tools = Array.isArray(toolOrTools) ? toolOrTools : [toolOrTools];
        for (const tool of tools) {
            this.tools.set(tool.id, tool);
        }
    }

    /**
     * 按工具 ID 获取。
     *
     * @param toolId 内置工具 ID。
     * @returns 描述符；未注册时返回 `undefined`。
     */
    get(toolId: BuiltInToolId): BuiltInTool | undefined;
    get(toolId: string): BuiltInTool | undefined;
    get(toolId: string): BuiltInTool | undefined {
        return this.tools.get(toolId as BuiltInToolId);
    }

    /**
     * 列出当前已注册的全部描述符。
     *
     * @returns 描述符列表。
     */
    list(): BuiltInTool[] {
        return Array.from(this.tools.values());
    }
}

export const builtInToolRegistry = new BuiltInToolRegistry();

builtInToolRegistry.register(bashTools);
builtInToolRegistry.register(fileSearchTools);
builtInToolRegistry.register(settingTools);
builtInToolRegistry.register(webFetchTools);
builtInToolRegistry.register(upgradeModelTools);
builtInToolRegistry.register(widgetToolTools);

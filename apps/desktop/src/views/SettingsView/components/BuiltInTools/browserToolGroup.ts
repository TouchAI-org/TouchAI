// Copyright (c) 2026. 千诚. Licensed under GPL v3

import type { BuiltInToolEntity } from './types';
import { isBrowserAutomationToolId } from './types';

export function getBrowserAutomationTools(tools: BuiltInToolEntity[]): BuiltInToolEntity[] {
    return tools.filter((tool) => isBrowserAutomationToolId(tool.tool_id));
}

export function getBuiltInToolUpdateTargets(
    tools: BuiltInToolEntity[],
    tool: BuiltInToolEntity | null | undefined
): BuiltInToolEntity[] {
    if (!tool) {
        return [];
    }

    if (isBrowserAutomationToolId(tool.tool_id)) {
        return getBrowserAutomationTools(tools);
    }

    return [tool];
}

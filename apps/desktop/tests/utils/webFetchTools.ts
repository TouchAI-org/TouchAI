import { createWebFetchOperations, createWebFetchTools } from '@/modules/tools';

import { toolMessages } from './toolMessages';

export function createWebFetchToolsFixture() {
    const tool = createWebFetchTools({ messages: toolMessages })[0]!;
    return {
        tool,
        execute: tool.execute.bind(tool),
        operations: createWebFetchOperations(toolMessages),
    };
}

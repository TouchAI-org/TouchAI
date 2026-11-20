import { createWebFetchOperations, createWebFetchTools } from '@/modules/tools';

import { toolMessages } from './toolMessages';

export function createWebFetchToolsFixture(
    configuration = {
        read: async (): Promise<string | null> => JSON.stringify({ fetchStrategy: 'direct' }),
    }
) {
    const tool = createWebFetchTools({ messages: toolMessages, configuration })[0]!;
    return {
        tool,
        execute: tool.execute.bind(tool),
        operations: createWebFetchOperations(toolMessages),
    };
}

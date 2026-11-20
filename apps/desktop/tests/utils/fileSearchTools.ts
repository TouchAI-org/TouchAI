import { createFileSearchOperations, createFileSearchTools } from '@/modules/tools';

import { toolMessages } from './toolMessages';

export function createFileSearchToolsFixture() {
    const tool = createFileSearchTools({ messages: toolMessages })[0]!;
    return {
        tool,
        executeFileSearchTool: tool.execute.bind(tool),
        ...createFileSearchOperations(toolMessages),
    };
}

import { createBashOperations, createBashTools } from '@/modules/tools';

import { toolMessages } from './toolMessages';

export function createBashToolsFixture() {
    const tool = createBashTools({ messages: toolMessages })[0]!;
    return {
        tool,
        operations: createBashOperations(toolMessages),
        execute: tool.execute.bind(tool),
        approval: (
            args: Record<string, unknown>,
            config: Parameters<typeof tool.buildApprovalRequest>[1]
        ) =>
            tool.buildApprovalRequest(args, config, 'builtin__bash', {
                callId: 'approval',
                iteration: 0,
            }),
    };
}

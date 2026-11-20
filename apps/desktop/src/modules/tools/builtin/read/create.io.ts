import {
    type BaseBuiltInToolExecutionContext,
    BuiltInTool,
    type BuiltInToolExecutionResult,
    type BuiltInToolGroup,
} from '../../contracts/builtin';
import type { ToolAttachmentCapabilities, ToolMessages } from '../../contracts/host';
import { READ_TOOL_DESCRIPTION, READ_TOOL_INPUT_SCHEMA } from './constants';
import { createReadOperations } from './operations.io';

export function createReadTools(input: {
    messages: ToolMessages;
    attachments: ToolAttachmentCapabilities;
}): BuiltInToolGroup {
    class ReadTool extends BuiltInTool<Record<string, never>> {
        readonly id = 'read' as const;
        readonly displayName = 'Read';
        readonly description = READ_TOOL_DESCRIPTION;
        readonly inputSchema = READ_TOOL_INPUT_SCHEMA;
        readonly defaultConfig = {};
        private readonly operations = createReadOperations(input);

        override async prepareForTurn() {
            return new ReadTool();
        }
        override buildApprovalRequest(args: Record<string, unknown>) {
            return this.operations.buildReadApprovalRequest(args);
        }
        override buildConversationSemantic(args: Record<string, unknown>) {
            return this.operations.buildReadConversationSemantic(args);
        }

        override async execute(
            args: Record<string, unknown>,
            _config: Record<string, never>,
            context: BaseBuiltInToolExecutionContext
        ): Promise<BuiltInToolExecutionResult> {
            try {
                const output = await this.operations.executeReadFile(args, context);
                return {
                    result: output.result,
                    attachments: output.attachments,
                    isError: false,
                    status: 'success',
                };
            } catch (error) {
                const errorMessage = error instanceof Error ? error.message : String(error);
                return { result: errorMessage, isError: true, status: 'error', errorMessage };
            }
        }
    }
    return [new ReadTool()];
}

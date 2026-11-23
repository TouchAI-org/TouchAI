import type { BuiltInToolGroup } from '../../contracts/builtin';
import type { ToolMessages } from '../../contracts/host';
import type { ReadConversationHistory } from './create';
import { createReadConversationTools as createReadConversationToolsCore } from './create';
import { databaseReadConversationHistory } from './operations.io';

export function createReadConversationTools(input: {
    messages: ToolMessages;
    history?: ReadConversationHistory;
}): BuiltInToolGroup {
    return createReadConversationToolsCore({
        ...input,
        history: input.history ?? databaseReadConversationHistory,
    });
}

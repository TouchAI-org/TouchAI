import type { BuiltInToolGroup } from '../../contracts/builtin';
import type { ToolMessages, ToolModelCapabilities } from '../../contracts/host';
import {
    createSearchConversationTools as createConversationSearchTools,
    type SearchConversationHistory,
} from './create';
import { databaseSearchConversationHistory } from './operations.io';

export function createSearchConversationTools(input: {
    messages: ToolMessages;
    models: ToolModelCapabilities;
    history?: SearchConversationHistory;
}): BuiltInToolGroup {
    return createConversationSearchTools({
        ...input,
        history: input.history ?? databaseSearchConversationHistory,
    });
}

// Copyright (c) 2026. Qian Cheng. Licensed under GPL v3

import type {
    ToolEventBuiltInConversationSemantic,
    ToolEventBuiltInConversationSemanticAction,
} from './tooling';

export type BuiltInToolConversationStatus =
    | 'executing'
    | 'awaiting_approval'
    | 'completed'
    | 'error'
    | 'rejected'
    | 'cancelled';

export type BuiltInToolConversationSemanticAction = ToolEventBuiltInConversationSemanticAction;

export type BuiltInToolConversationSemantic = ToolEventBuiltInConversationSemantic;

export interface BuiltInToolConversationPresentation {
    verb: string;
    content?: string;
}

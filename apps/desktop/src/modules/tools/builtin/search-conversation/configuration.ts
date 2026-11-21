import { z } from '@/utils/zod';

export interface SearchConversationToolConfig {
    enabled: boolean;
}

export const DEFAULT_SEARCH_CONVERSATION_TOOL_CONFIG: SearchConversationToolConfig = {
    enabled: true,
};

const configSchema = z.object({
    enabled: z.boolean().default(true),
});

export function parseSearchConversationToolConfig(
    text: string | null
): SearchConversationToolConfig {
    if (!text) return { ...DEFAULT_SEARCH_CONVERSATION_TOOL_CONFIG };
    try {
        const parsed = configSchema.safeParse(JSON.parse(text));
        return parsed.success ? parsed.data : { ...DEFAULT_SEARCH_CONVERSATION_TOOL_CONFIG };
    } catch {
        return { ...DEFAULT_SEARCH_CONVERSATION_TOOL_CONFIG };
    }
}

export function serializeSearchConversationToolConfig(
    config: SearchConversationToolConfig
): string {
    return JSON.stringify({
        enabled: config.enabled !== false,
    });
}

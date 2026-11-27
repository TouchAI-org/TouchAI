import { z } from '@/utils/zod';

export interface ReadConversationToolConfig {
    enabled: boolean;
}

export const DEFAULT_READ_CONVERSATION_TOOL_CONFIG: ReadConversationToolConfig = {
    enabled: true,
};

const configSchema = z.object({
    enabled: z.boolean().default(true),
});

export function parseReadConversationToolConfig(text: string | null): ReadConversationToolConfig {
    if (!text) return { ...DEFAULT_READ_CONVERSATION_TOOL_CONFIG };
    try {
        const parsed = configSchema.safeParse(JSON.parse(text));
        return parsed.success ? parsed.data : { ...DEFAULT_READ_CONVERSATION_TOOL_CONFIG };
    } catch {
        return { ...DEFAULT_READ_CONVERSATION_TOOL_CONFIG };
    }
}

export function serializeReadConversationToolConfig(config: ReadConversationToolConfig): string {
    return JSON.stringify({
        enabled: config.enabled !== false,
    });
}

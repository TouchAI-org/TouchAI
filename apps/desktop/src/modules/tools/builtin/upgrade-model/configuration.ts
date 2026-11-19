import { parseJsonWithSchema } from '@/utils/zod';

import type { ToolMessages } from '../../contracts/host';
import { nonEmptyTrimmedStringSchema, parseToolConfigJson, z } from '../../execution/schema';

export interface UpgradeModelChainEntry {
    providerId: number;
    modelId: string;
}
export interface UpgradeModelToolConfig {
    chain: UpgradeModelChainEntry[];
}
export const DEFAULT_UPGRADE_MODEL_TOOL_CONFIG: UpgradeModelToolConfig = { chain: [] };

export function isSameUpgradeModelChainEntry(
    left: UpgradeModelChainEntry,
    right: UpgradeModelChainEntry
): boolean {
    return left.providerId === right.providerId && left.modelId === right.modelId;
}

export function createUpgradeModelConfiguration(messages: Pick<ToolMessages, 'tt'>) {
    const entrySchema = z.object({
        providerId: z.number().int(),
        modelId: nonEmptyTrimmedStringSchema,
    });
    const arrayError = () => messages.tt('升级链条必须是数组或可解析为数组的 JSON 字符串。');
    const normalizeEntry = (value: unknown): UpgradeModelChainEntry => {
        const parsed = entrySchema.safeParse(value);
        if (!parsed.success)
            throw new Error(
                messages.tt('升级链条中的每一项都必须包含 providerId 和非空 modelId。')
            );
        return parsed.data;
    };
    const normalizeChain = (value: unknown): UpgradeModelChainEntry[] => {
        if (value === undefined || value === null || value === '') return [];
        const entries =
            typeof value === 'string'
                ? parseJsonWithSchema(z.unknown(), value, arrayError())
                : value;
        if (!Array.isArray(entries)) throw new Error(arrayError());
        const seen = new Set<string>();
        return entries.map(normalizeEntry).filter((entry) => {
            const key = `${entry.providerId}:${entry.modelId}`;
            if (seen.has(key)) return false;
            seen.add(key);
            return true;
        });
    };
    const schema = z
        .object({ chain: z.array(entrySchema).optional() })
        .transform(
            (value): UpgradeModelToolConfig => ({ chain: normalizeChain(value.chain ?? []) })
        );
    return Object.freeze({
        isEntry: (value: unknown): value is UpgradeModelChainEntry =>
            entrySchema.safeParse(value).success,
        normalizeEntry,
        normalizeChain,
        parse: (text: string | null): UpgradeModelToolConfig =>
            parseToolConfigJson(schema, text, DEFAULT_UPGRADE_MODEL_TOOL_CONFIG),
        serialize: (config: UpgradeModelToolConfig): string =>
            JSON.stringify({ chain: normalizeChain(config.chain) }),
        clone: (config: UpgradeModelToolConfig): UpgradeModelToolConfig => ({
            chain: normalizeChain(config.chain),
        }),
        summary: (config: UpgradeModelToolConfig): string =>
            JSON.stringify(normalizeChain(config.chain)),
        formatChain: (entries: UpgradeModelChainEntry[]): string =>
            entries.length
                ? entries.map((entry) => `${entry.providerId}:${entry.modelId}`).join(' -> ')
                : messages.tt('未配置'),
    });
}

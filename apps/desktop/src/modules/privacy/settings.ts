import { DEFAULT_PRIVACY_MODEL_ID, type PrivacyFilterModelId } from '@/config/privacy';
import { z } from '@/utils/zod';

export const PRIVACY_FILTER_SETTINGS_KEY = 'privacy_filter_settings';
export const PRIVACY_FILTER_MODEL_KEY = 'privacy_filter_model_id';
export const PRIVACY_FILTER_FAILURE_ACTION_KEY = 'privacy_filter_failure_action';

export type PrivacyFilterFailureAction = 'block' | 'fallback-rules' | 'send-original';

export function normalizePrivacyFilterFailureAction(value: unknown): PrivacyFilterFailureAction {
    if (value === null || value === undefined) return 'fallback-rules';
    return value === 'fallback-rules' || value === 'send-original' ? value : 'block';
}

export function normalizePrivacyFilterModelId(value: unknown): PrivacyFilterModelId {
    return value === 'openai-privacy-filter' ||
        value === 'openmed-privacy-filter' ||
        value === 'astrlink-guard-int8'
        ? value
        : DEFAULT_PRIVACY_MODEL_ID;
}
export const PRIVACY_FILTER_SETTINGS_VERSION = 2;

export const PRIVACY_DATA_TYPES = [
    'email',
    'phone',
    'privatePerson',
    'privateAddress',
    'privateDate',
    'account',
    'paymentCard',
    'ipAddress',
    'url',
] as const;

export type PrivacyDataType = (typeof PRIVACY_DATA_TYPES)[number];

/** A top-level category the user can enable independently. */
export type PrivacyFilterCategory = 'secrets' | PrivacyDataType;

/** Categories shown as one toggleable group, starting with secrets. */
export const PRIVACY_FILTER_CATEGORIES: readonly PrivacyFilterCategory[] = [
    'secrets',
    ...PRIVACY_DATA_TYPES,
];

/** Categories algorithm rules recognize (secrets + the rule list). */
export const RULE_DATA_TYPES: readonly PrivacyDataType[] = [
    'email',
    'phone',
    'account',
    'paymentCard',
];

export interface PrivacyFilterSettings {
    version: typeof PRIVACY_FILTER_SETTINGS_VERSION;
    enabled: boolean;
    /** Fine-grained categories, including `secrets` when enabled. */
    categories: Record<PrivacyFilterCategory, boolean>;
    useLocalModel: boolean;
    confidenceThreshold: number;
    maskedWords: string[];
    neverMask: string[];
    secretPrefixes: string[];
}

export const DEFAULT_PRIVACY_FILTER_SETTINGS: PrivacyFilterSettings = {
    version: PRIVACY_FILTER_SETTINGS_VERSION,
    enabled: false,
    categories: {
        secrets: true,
        email: true,
        phone: true,
        privatePerson: true,
        privateAddress: true,
        privateDate: true,
        account: true,
        paymentCard: true,
        ipAddress: false,
        url: false,
    },
    useLocalModel: true,
    confidenceThreshold: 0.8,
    maskedWords: [],
    neverMask: [],
    secretPrefixes: [],
};

const settingsSchema = z
    .object({
        version: z.number().int().optional(),
        enabled: z.boolean().optional(),
        maskSecrets: z.boolean().optional(),
        maskPersonalData: z.boolean().optional(),
        personalDataTypes: z.record(z.string(), z.boolean()).optional(),
        useLocalModel: z.boolean().optional(),
        confidenceThreshold: z.number().optional(),
        maskedWords: z.array(z.string()).optional(),
        neverMask: z.array(z.string()).optional(),
        secretPrefixes: z.array(z.string()).optional(),
        categories: z.record(z.string(), z.boolean()).optional(),
    })
    .passthrough();

function normalizeList(values: string[] | undefined, maximumItems = 500): string[] {
    if (!values) {
        return [];
    }

    const seen = new Set<string>();
    const normalized: string[] = [];
    for (const value of values) {
        const item = value.trim();
        const key = item.toLocaleLowerCase();
        if (!item || item.length > 256 || seen.has(key)) {
            continue;
        }
        seen.add(key);
        normalized.push(item);
        if (normalized.length >= maximumItems) {
            break;
        }
    }
    return normalized;
}

export function normalizePrivacyFilterSettings(value: unknown): PrivacyFilterSettings {
    const parsed = settingsSchema.safeParse(value);
    if (!parsed.success) {
        return {
            ...DEFAULT_PRIVACY_FILTER_SETTINGS,
            categories: { ...DEFAULT_PRIVACY_FILTER_SETTINGS.categories },
        };
    }

    const data = parsed.data;
    const confidenceThreshold = Number.isFinite(data.confidenceThreshold)
        ? Math.min(1, Math.max(0, data.confidenceThreshold ?? 0.8))
        : DEFAULT_PRIVACY_FILTER_SETTINGS.confidenceThreshold;

    // Read legacy booleans and maps; categories are the only writable source.
    const savedCategories = data.categories;
    const categories = Object.fromEntries(
        PRIVACY_FILTER_CATEGORIES.map((category) => [
            category,
            savedCategories?.[category] ??
                (category === 'secrets'
                    ? (data.maskSecrets ?? DEFAULT_PRIVACY_FILTER_SETTINGS.categories.secrets)
                    : (data.personalDataTypes?.[category] ??
                      data.maskPersonalData ??
                      DEFAULT_PRIVACY_FILTER_SETTINGS.categories[category])),
        ])
    ) as Record<PrivacyFilterCategory, boolean>;
    return {
        version: PRIVACY_FILTER_SETTINGS_VERSION,
        enabled: data.enabled ?? DEFAULT_PRIVACY_FILTER_SETTINGS.enabled,
        categories,
        useLocalModel: data.useLocalModel ?? DEFAULT_PRIVACY_FILTER_SETTINGS.useLocalModel,
        confidenceThreshold,
        maskedWords: normalizeList(data.maskedWords),
        neverMask: normalizeList(data.neverMask),
        secretPrefixes: normalizeList(data.secretPrefixes),
    };
}

export function parsePrivacyFilterSettings(raw: string | null): PrivacyFilterSettings {
    if (!raw) {
        return normalizePrivacyFilterSettings(null);
    }

    try {
        return normalizePrivacyFilterSettings(JSON.parse(raw));
    } catch {
        return normalizePrivacyFilterSettings(null);
    }
}

export function serializePrivacyFilterSettings(value: PrivacyFilterSettings): string {
    return JSON.stringify(normalizePrivacyFilterSettings(value));
}

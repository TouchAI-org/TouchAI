// Copyright (c) 2026. Qian Cheng. Licensed under GPL v3

import { log } from '@services/ObservabilityService';

import { t } from '@/i18n';

import type {
    ModelPreferenceCreateData,
    ModelPreferenceEntity,
    ModelPreferenceUpdateData,
    ModelPreferenceWithModel,
    ModelRole,
    ModelWithProvider,
} from '../types';
import {
    findDefaultModelWithProvider,
    findModelByIdWithProvider,
    findModelsWithProvider,
    setDefaultModel,
} from './models';
import { getSettingValue, setSetting } from './settings';

export type { ModelRole } from '../types';

export const MODEL_PREFERENCES_SETTING_KEY = 'model_preferences';
export const MODEL_ROUTING_ENABLED_SETTING_KEY = 'allow_model_auto_switch';
export const MODEL_ROLE_SETTING_KEYS = {
    fast: 'model_role_fast_model_id',
    general: 'model_role_general_model_id',
} as const;

const MODEL_ROLE_VALUES: ModelRole[] = ['entry', 'fast', 'general'];

function isRecord(value: unknown): value is Record<string, unknown> {
    return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function isPositiveInteger(value: unknown): value is number {
    return typeof value === 'number' && Number.isInteger(value) && value > 0;
}

function parseStoredPreference(value: unknown): ModelPreferenceEntity | null {
    if (!isRecord(value)) {
        return null;
    }

    const id = typeof value.id === 'string' ? value.id.trim() : '';
    const name = typeof value.name === 'string' ? value.name.trim() : '';
    const description = typeof value.description === 'string' ? value.description.trim() : '';
    const providerId = isPositiveInteger(value.provider_id) ? value.provider_id : null;
    const modelId = isPositiveInteger(value.model_id) ? value.model_id : null;
    const priority =
        typeof value.priority === 'number' && Number.isFinite(value.priority) ? value.priority : 0;
    const createdAt = typeof value.created_at === 'string' ? value.created_at : '';
    const updatedAt = typeof value.updated_at === 'string' ? value.updated_at : '';

    if (!id || !name || !description) {
        return null;
    }

    return {
        id,
        name,
        description,
        provider_id: providerId,
        model_id: modelId,
        priority,
        created_at: createdAt,
        updated_at: updatedAt,
    };
}

async function readStoredPreferences(): Promise<ModelPreferenceEntity[]> {
    const raw = await getSettingValue({ key: MODEL_PREFERENCES_SETTING_KEY });
    if (!raw) {
        return [];
    }

    try {
        const parsed: unknown = JSON.parse(raw);
        if (!Array.isArray(parsed)) {
            log.warn('[ModelPreferences] Ignoring a non-array preference setting');
            return [];
        }

        return parsed
            .map(parseStoredPreference)
            .filter((preference): preference is ModelPreferenceEntity => preference !== null);
    } catch (error) {
        log.warn('[ModelPreferences] Ignoring malformed preference setting:', error);
        return [];
    }
}

async function writeStoredPreferences(preferences: ModelPreferenceEntity[]): Promise<void> {
    await setSetting({
        key: MODEL_PREFERENCES_SETTING_KEY,
        value: JSON.stringify(preferences),
    });
}

function normalizeName(value: string): string {
    return value.trim();
}

function assertUniqueName(
    preferences: ModelPreferenceEntity[],
    name: string,
    ignoredId?: string
): void {
    const normalized = name.toLocaleLowerCase();
    const duplicate = preferences.some(
        (preference) =>
            preference.id !== ignoredId && preference.name.toLocaleLowerCase() === normalized
    );
    if (duplicate) {
        throw new Error(t('settings.modelRouting.duplicateName', { name }));
    }
}

async function requireEnabledModel(modelId: number): Promise<ModelWithProvider> {
    const model = await findModelByIdWithProvider(modelId);
    if (!model) {
        throw new Error(t('settings.modelRouting.modelNotFound'));
    }
    if (model.provider_enabled === 0) {
        throw new Error(t('settings.modelRouting.modelUnavailable'));
    }
    return model;
}

function resolvePreferenceModel(
    preference: ModelPreferenceEntity,
    modelsById: Map<number, ModelWithProvider>
): ModelPreferenceWithModel {
    const model = preference.model_id === null ? undefined : modelsById.get(preference.model_id);

    return {
        ...preference,
        model_name: model?.name ?? null,
        model_api_id: model?.model_id ?? null,
        model_provider_id: model?.provider_id ?? preference.provider_id,
        provider_name: model?.provider_name ?? null,
        provider_enabled: model?.provider_enabled ?? null,
    };
}

export const listModelPreferences = async (): Promise<ModelPreferenceWithModel[]> => {
    const [preferences, models] = await Promise.all([
        readStoredPreferences(),
        findModelsWithProvider(),
    ]);
    const modelsById = new Map(models.map((model) => [model.id, model]));

    return preferences
        .slice()
        .sort(
            (left, right) =>
                left.priority - right.priority ||
                left.created_at.localeCompare(right.created_at) ||
                left.id.localeCompare(right.id)
        )
        .map((preference) => resolvePreferenceModel(preference, modelsById));
};

export const findModelPreferenceByName = async (
    name: string
): Promise<ModelPreferenceWithModel | undefined> => {
    const normalized = name.trim();
    if (!normalized) {
        return undefined;
    }

    const preferences = await listModelPreferences();
    return preferences.find((preference) => preference.name === normalized);
};

export const createModelPreference = async (
    draft: ModelPreferenceCreateData
): Promise<ModelPreferenceEntity> => {
    const name = normalizeName(draft.name);
    const description = draft.description.trim();
    if (!name) {
        throw new Error(t('settings.modelRouting.nameRequired'));
    }
    if (!description) {
        throw new Error(t('settings.modelRouting.descriptionRequired'));
    }
    if (!isPositiveInteger(draft.model_id)) {
        throw new Error(t('settings.modelRouting.modelRequired'));
    }
    const modelId = draft.model_id;

    const [preferences, model] = await Promise.all([
        readStoredPreferences(),
        requireEnabledModel(modelId),
    ]);
    assertUniqueName(preferences, name);

    const now = new Date().toISOString();
    const nextPreference: ModelPreferenceEntity = {
        id: crypto.randomUUID(),
        name,
        description,
        provider_id: model.provider_id,
        model_id: model.id,
        priority:
            draft.priority !== undefined && Number.isFinite(draft.priority)
                ? draft.priority
                : preferences.reduce(
                      (highest, preference) => Math.max(highest, preference.priority),
                      -1
                  ) + 1,
        created_at: draft.created_at ?? now,
        updated_at: draft.updated_at ?? now,
    };

    await writeStoredPreferences([...preferences, nextPreference]);
    return nextPreference;
};

export const updateModelPreference = async (
    id: string,
    patch: ModelPreferenceUpdateData
): Promise<void> => {
    const preferences = await readStoredPreferences();
    const current = preferences.find((preference) => preference.id === id);
    if (!current) {
        throw new Error(t('settings.modelRouting.notFound'));
    }

    const name = patch.name === undefined ? current.name : normalizeName(patch.name);
    const description =
        patch.description === undefined ? current.description : patch.description.trim();
    if (!name) {
        throw new Error(t('settings.modelRouting.nameRequired'));
    }
    if (!description) {
        throw new Error(t('settings.modelRouting.descriptionRequired'));
    }
    assertUniqueName(preferences, name, id);

    let model: ModelWithProvider | undefined;
    if (patch.model_id !== undefined && patch.model_id !== null) {
        model = await requireEnabledModel(patch.model_id);
    }

    const nextPreference: ModelPreferenceEntity = {
        ...current,
        name,
        description,
        provider_id: model?.provider_id ?? patch.provider_id ?? current.provider_id,
        model_id: patch.model_id === undefined ? current.model_id : patch.model_id,
        priority:
            patch.priority !== undefined && Number.isFinite(patch.priority)
                ? patch.priority
                : current.priority,
        updated_at: new Date().toISOString(),
    };

    await writeStoredPreferences(
        preferences.map((preference) => (preference.id === id ? nextPreference : preference))
    );
};

export const deleteModelPreference = async (id: string): Promise<boolean> => {
    const preferences = await readStoredPreferences();
    const nextPreferences = preferences.filter((preference) => preference.id !== id);
    if (nextPreferences.length === preferences.length) {
        return false;
    }

    await writeStoredPreferences(nextPreferences);
    return true;
};

export const isModelRoutingEnabled = async (): Promise<boolean> => {
    try {
        return (await getSettingValue({ key: MODEL_ROUTING_ENABLED_SETTING_KEY })) === 'true';
    } catch (error) {
        log.warn('[ModelPreferences] Failed to read model routing setting:', error);
        return false;
    }
};

export const findModelRoleWithProvider = async (
    role: ModelRole
): Promise<ModelWithProvider | null> => {
    if (!MODEL_ROLE_VALUES.includes(role)) {
        return null;
    }

    if (role === 'entry') {
        return findDefaultModelWithProvider();
    }

    const rawModelId = await getSettingValue({ key: MODEL_ROLE_SETTING_KEYS[role] });
    const modelId = rawModelId ? Number(rawModelId) : NaN;
    if (!Number.isInteger(modelId) || modelId <= 0) {
        return null;
    }

    const model = await findModelByIdWithProvider(modelId);
    if (!model || model.provider_enabled === 0) {
        return null;
    }

    return model;
};

export const findEffectiveModelRoleWithProvider = async (
    role: ModelRole
): Promise<ModelWithProvider | null> => {
    const roleModel = await findModelRoleWithProvider(role);
    if (roleModel) {
        return roleModel;
    }
    return findDefaultModelWithProvider();
};

export const setModelRole = async ({
    role,
    modelId,
}: {
    role: ModelRole;
    modelId: number | null;
}): Promise<void> => {
    if (!MODEL_ROLE_VALUES.includes(role)) {
        throw new Error(t('settings.modelRouting.roleInvalid'));
    }

    if (role === 'entry') {
        if (modelId === null) {
            throw new Error(t('settings.modelRouting.defaultModelRequired'));
        }
        await requireEnabledModel(modelId);
        await setDefaultModel({ modelId });
        return;
    }

    if (modelId !== null) {
        await requireEnabledModel(modelId);
    }

    await setSetting({
        key: MODEL_ROLE_SETTING_KEYS[role],
        value: modelId === null ? '' : String(modelId),
    });
};

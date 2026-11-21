import { config } from '@vue/test-utils';
import { createPinia, disposePinia, setActivePinia } from 'pinia';
import { afterEach, beforeEach, vi } from 'vitest';

import {
    DEFAULT_PRIVACY_FILTER_SETTINGS,
    DEFAULT_PRIVACY_MODEL_ID,
    type PrivacyApi,
    privacyApiKey,
} from '@/app/api/privacy';

export function createTestPrivacyApi(overrides: Partial<PrivacyApi> = {}): PrivacyApi {
    const settings = {
        ...DEFAULT_PRIVACY_FILTER_SETTINGS,
        categories: { ...DEFAULT_PRIVACY_FILTER_SETTINGS.categories },
    };
    const cleanup = () => undefined;
    return {
        initialize: async () => undefined,
        refresh: async () => undefined,
        getPrivacyFilterSettings: () => settings,
        getPrivacyFilterModelId: () => DEFAULT_PRIVACY_MODEL_ID,
        getPrivacyFilterFailureAction: () => 'fallback-rules',
        updatePrivacyFilterSettings: async () => undefined,
        updatePrivacyFilterModelId: async () => undefined,
        updatePrivacyFilterFailureAction: async () => undefined,
        subscribeSettings: () => cleanup,
        getRecords: async () => [],
        getDetailRecordIds: async () => [],
        getRecordDetails: async () => null,
        clearRecords: async () => undefined,
        findSessionTitles: async () => [],
        getModels: async () => [],
        getModelStatus: async () => ({
            modelId: DEFAULT_PRIVACY_MODEL_ID,
            installed: false,
            downloading: false,
            downloadedBytes: 0,
            totalBytes: 0,
            currentFile: null,
        }),
        downloadModel: async () => undefined,
        cancelModelDownload: async () => undefined,
        deleteModel: async () => undefined,
        releaseModels: async () => undefined,
        detect: async () => [],
        onRecordsChanged: async () => cleanup,
        onDownloadProgress: async () => cleanup,
        getReviewSnapshot: () => ({ generation: 0, annotations: [] }),
        getReviewGeneration: () => 0,
        subscribeReview: () => cleanup,
        publishPrivacyReview: vi.fn(),
        clearPrivacyReview: vi.fn(),
        publishRestoredPrivacyReview: vi.fn(),
        selectPrivacyAnnotations: () => [],
        selectRestoredPrivacyAnnotations: () => [],
        ...overrides,
    };
}

export function useTestPrivacyApi(overrides: Partial<PrivacyApi> = {}) {
    let pinia: ReturnType<typeof createPinia> | undefined;
    beforeEach(() => {
        pinia = createPinia();
        setActivePinia(pinia);
        Reflect.set(config.global.provide, privacyApiKey, createTestPrivacyApi(overrides));
    });
    afterEach(() => {
        if (pinia) disposePinia(pinia);
        Reflect.deleteProperty(config.global.provide, privacyApiKey);
    });
}

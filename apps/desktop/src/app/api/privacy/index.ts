import { inject, type InjectionKey } from 'vue';

import type {
    PrivacyFilterDownloadProgress,
    PrivacyFilterFailureAction,
    PrivacyFilterModelId,
    PrivacyFilterModelInfo,
    PrivacyFilterModelSource,
    PrivacyFilterModelStatus,
    PrivacyFilterSettings,
    PrivacyFilterSpan,
    PrivacyProtectionDetails,
    PrivacyProtectionRecord,
    PrivacyRestoredSpan,
    PrivacyReviewAnnotation,
    PrivacyReviewSnapshot,
} from '@/modules/privacy/public';

export * from '@/modules/privacy/public';

export interface PrivacySettingsApi {
    initialize(): Promise<void>;
    refresh(): Promise<void>;
    getPrivacyFilterSettings(): PrivacyFilterSettings;
    getPrivacyFilterModelId(): PrivacyFilterModelId;
    getPrivacyFilterFailureAction(): PrivacyFilterFailureAction;
    updatePrivacyFilterSettings(value: PrivacyFilterSettings): Promise<void>;
    updatePrivacyFilterModelId(value: PrivacyFilterModelId): Promise<void>;
    updatePrivacyFilterFailureAction(value: PrivacyFilterFailureAction): Promise<void>;
    subscribeSettings(listener: () => void): () => void;
}

/** Window-scoped commands and memory-only review state, assembled before mounting. */
export interface PrivacyApi extends PrivacySettingsApi {
    getRecords(): Promise<PrivacyProtectionRecord[]>;
    getDetailRecordIds(): Promise<string[]>;
    getRecordDetails(id: string): Promise<PrivacyProtectionDetails | null>;
    clearRecords(): Promise<void>;
    findSessionTitles(ids: number[]): Promise<Array<{ id: number; title: string }>>;
    getModels(): Promise<PrivacyFilterModelInfo[]>;
    getModelStatus(id?: PrivacyFilterModelId): Promise<PrivacyFilterModelStatus>;
    downloadModel(id?: PrivacyFilterModelId, source?: PrivacyFilterModelSource): Promise<void>;
    cancelModelDownload(id?: PrivacyFilterModelId): Promise<void>;
    deleteModel(id?: PrivacyFilterModelId): Promise<void>;
    releaseModels(): Promise<void>;
    detect(texts: string[], id?: PrivacyFilterModelId): Promise<PrivacyFilterSpan[][]>;
    onRecordsChanged(listener: () => void): Promise<() => void>;
    onDownloadProgress(
        listener: (progress: PrivacyFilterDownloadProgress) => void
    ): Promise<() => void>;
    getReviewSnapshot(): PrivacyReviewSnapshot;
    getReviewGeneration(): number;
    subscribeReview(listener: () => void): () => void;
    publishPrivacyReview(annotations: PrivacyReviewAnnotation[], generation?: number): void;
    clearPrivacyReview(): void;
    publishRestoredPrivacyReview(
        partId: string,
        offset: number,
        spans: PrivacyRestoredSpan[],
        generation: number
    ): void;
    selectPrivacyAnnotations(
        id: number | undefined,
        text: string,
        hash: string
    ): PrivacyReviewAnnotation[];
    selectRestoredPrivacyAnnotations(
        partId: string | undefined,
        text: string
    ): PrivacyReviewAnnotation[];
}

export const privacyApiKey: InjectionKey<PrivacyApi> = Symbol('touchai.privacy');
export function usePrivacyApi(): PrivacyApi {
    const api = inject(privacyApiKey);
    if (!api) throw new Error('PRIVACY_CLIENT_UNAVAILABLE');
    return api;
}

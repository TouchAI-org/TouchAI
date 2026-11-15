import { invoke } from './invoke';

export const PRIVACY_FILTER_DOWNLOAD_PROGRESS_EVENT = 'privacy-filter-download-progress';
export const PRIVACY_FILTER_RECORDS_CHANGED_EVENT = 'privacy-filter-records-changed';
export const PRIVACY_FILTER_RECORDS_RETENTION_DAYS = 30;
export const PRIVACY_FILTER_RECORDS_LIMIT = 200;
export const PRIVACY_FILTER_DETAIL_RECORDS_LIMIT = 20;
export const PRIVACY_FILTER_DETAIL_VALUES_LIMIT = 200;
export const PRIVACY_FILTER_DETAIL_TEXTS_LIMIT = 20;
export const PRIVACY_FILTER_DETAIL_BYTES_LIMIT = 64 * 1024;

export type PrivacyFilterModelSource = 'auto' | 'huggingface' | 'hf-mirror';
export type PrivacyFilterModelId =
    | 'astrlink-guard-int8'
    | 'openai-privacy-filter'
    | 'openmed-privacy-filter';
export const DEFAULT_PRIVACY_MODEL_ID: PrivacyFilterModelId = 'astrlink-guard-int8';
export type PrivacyProtectionKind =
    | 'secret'
    | 'email'
    | 'phone'
    | 'privatePerson'
    | 'privateAddress'
    | 'privateDate'
    | 'account'
    | 'paymentCard'
    | 'ipAddress'
    | 'url'
    | 'custom';

export interface PrivacyProtectionSummary {
    maskedCount: number;
    categories: Array<{ kind: PrivacyProtectionKind; count: number }>;
}

export interface PrivacyProtectionRecordInput extends PrivacyProtectionSummary {
    mode: 'rules' | 'model';
    outcome: 'protected' | 'blocked';
}

export interface PrivacyProtectionRecord extends PrivacyProtectionRecordInput {
    id: string;
    createdAt: number;
}

export type PrivacyProtectionRule =
    | {
          id:
              | 'privateKey'
              | 'apiKey'
              | 'jwt'
              | 'secretAssignment'
              | 'urlPassword'
              | 'email'
              | 'phone'
              | 'chinaId'
              | 'paymentCard';
      }
    | { id: 'customPrefix' | 'customWord'; value: string }
    | { id: 'localModel'; modelId: PrivacyFilterModelId };

export type PrivacyProtectionRuleMatch = PrivacyProtectionRule & { count: number };

export interface PrivacyProtectionValue {
    kind: PrivacyProtectionKind;
    original: string;
    placeholder: string;
    count: number;
    matches?: PrivacyProtectionRuleMatch[];
}

/** Memory-only content, fetched separately from the persisted summary. */
export interface PrivacyProtectionDetails {
    values: PrivacyProtectionValue[];
    texts: string[];
    truncated: boolean;
}

export interface PrivacyFilterModelInfo {
    id: PrivacyFilterModelId;
    name: string;
    totalBytes: number;
    supported: boolean;
    recommended: boolean;
    dataTypes: Exclude<PrivacyProtectionKind, 'secret' | 'custom'>[];
}

export interface PrivacyFilterModelStatus {
    modelId: PrivacyFilterModelId;
    installed: boolean;
    downloading: boolean;
    downloadedBytes: number;
    totalBytes: number;
    currentFile: string | null;
}

export interface PrivacyFilterDownloadProgress {
    modelId: PrivacyFilterModelId;
    downloadedBytes: number;
    totalBytes: number;
    currentFile: string;
}

export interface PrivacyFilterSpan {
    start: number;
    end: number;
    kind: string;
    score: number;
}

export const privacyFilter = {
    recordProtection(
        record: PrivacyProtectionRecordInput,
        details?: PrivacyProtectionDetails
    ): Promise<void> {
        return invoke<void>('privacy_filter_record_protection', {
            record,
            ...(details ? { details } : {}),
        });
    },

    getRecords(): Promise<PrivacyProtectionRecord[]> {
        return invoke<PrivacyProtectionRecord[]>('privacy_filter_records');
    },

    getRecordDetails(recordId: string): Promise<PrivacyProtectionDetails | null> {
        return invoke<PrivacyProtectionDetails | null>('privacy_filter_record_details', {
            recordId,
        });
    },

    clearRecords(): Promise<void> {
        return invoke<void>('privacy_filter_clear_records');
    },

    getModels(): Promise<PrivacyFilterModelInfo[]> {
        return invoke<PrivacyFilterModelInfo[]>('privacy_filter_models');
    },

    getModelStatus(
        modelId: PrivacyFilterModelId = DEFAULT_PRIVACY_MODEL_ID
    ): Promise<PrivacyFilterModelStatus> {
        return invoke<PrivacyFilterModelStatus>('privacy_filter_model_status', { modelId });
    },

    downloadModel(
        modelId: PrivacyFilterModelId = DEFAULT_PRIVACY_MODEL_ID,
        source: PrivacyFilterModelSource = 'auto'
    ): Promise<void> {
        return invoke<void>('privacy_filter_download_model', { modelId, source });
    },

    cancelModelDownload(modelId: PrivacyFilterModelId = DEFAULT_PRIVACY_MODEL_ID): Promise<void> {
        return invoke<void>('privacy_filter_cancel_model_download', { modelId });
    },

    deleteModel(modelId: PrivacyFilterModelId = DEFAULT_PRIVACY_MODEL_ID): Promise<void> {
        return invoke<void>('privacy_filter_delete_model', { modelId });
    },

    releaseModels(): Promise<void> {
        return invoke<void>('privacy_filter_release_models');
    },

    detect(
        texts: string[],
        modelId: PrivacyFilterModelId = DEFAULT_PRIVACY_MODEL_ID
    ): Promise<PrivacyFilterSpan[][]> {
        return invoke<PrivacyFilterSpan[][]>('privacy_filter_detect', { texts, modelId });
    },
} as const;

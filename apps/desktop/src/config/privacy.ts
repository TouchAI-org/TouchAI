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
    sessionId?: number;
    modelName?: string;
}

export interface PrivacyProtectionRecord extends PrivacyProtectionRecordInput {
    id: string;
    createdAt: number;
    direction?: 'mask' | 'restore';
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

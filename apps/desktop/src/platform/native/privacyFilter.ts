import {
    DEFAULT_PRIVACY_MODEL_ID,
    type PrivacyFilterModelId,
    type PrivacyFilterModelInfo,
    type PrivacyFilterModelSource,
    type PrivacyFilterModelStatus,
    type PrivacyFilterSpan,
    type PrivacyProtectionDetails,
    type PrivacyProtectionRecord,
    type PrivacyProtectionRecordInput,
} from '@/config/privacy';
export * from '@/config/privacy';

import { invoke } from './invoke';

export const privacyFilter = {
    recordRestoration(
        record: PrivacyProtectionRecordInput,
        details: PrivacyProtectionDetails,
        generation?: number
    ): Promise<void> {
        return invoke<void>('privacy_filter_record_restoration', {
            record,
            details,
            ...(generation === undefined ? {} : { generation }),
        });
    },

    recordProtection(
        record: PrivacyProtectionRecordInput,
        details?: PrivacyProtectionDetails,
        generation?: number
    ): Promise<void> {
        return invoke<void>('privacy_filter_record_protection', {
            record,
            ...(details ? { details } : {}),
            ...(generation === undefined ? {} : { generation }),
        });
    },

    getRecordGeneration(): Promise<number> {
        return invoke<number>('privacy_filter_record_generation');
    },

    getRecords(): Promise<PrivacyProtectionRecord[]> {
        return invoke<PrivacyProtectionRecord[]>('privacy_filter_records');
    },

    getDetailRecordIds(): Promise<string[]> {
        return invoke<string[]>('privacy_filter_record_detail_ids');
    },

    getRecordDetails(recordId: string): Promise<PrivacyProtectionDetails | null> {
        return invoke<PrivacyProtectionDetails | null>('privacy_filter_record_details', {
            recordId,
        });
    },

    clearRecords(): Promise<number> {
        return invoke<number>('privacy_filter_clear_records');
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

// Copyright (c) 2026. 千诚. Licensed under GPL v3

/** Stable metadata keys stored in `touchai_meta`. */
export enum MetaKey {
    APP_ID = 'app_id',
    IMPORT_SUCCESS = 'import_success',
}

/** Stable statistics keys stored in `statistics`. */
export enum StatisticKey {
    MODEL_METADATA_LAST_UPDATED_AT = 'model_metadata_last_updated_at',
    MODEL_METADATA_LAST_CHECKED_AT = 'model_metadata_last_checked_at',
    MODEL_METADATA_SOURCE_ETAG = 'model_metadata_source_etag',
    USAGE_MAINTENANCE_RUN_AT = 'usage_maintenance_run_at',
}

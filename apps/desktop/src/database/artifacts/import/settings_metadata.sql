DELETE FROM main.statistics WHERE key IN ('model_metadata_source_etag', 'model_metadata_last_checked_at', 'model_metadata_last_updated_at');
INSERT INTO main.statistics (key, value, created_at, updated_at)
SELECT key, value, created_at, updated_at FROM imported.statistics
WHERE key IN ('model_metadata_source_etag', 'model_metadata_last_checked_at', 'model_metadata_last_updated_at');

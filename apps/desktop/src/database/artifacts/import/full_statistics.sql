DELETE FROM main.statistics;
INSERT INTO main.statistics (key, value, created_at, updated_at)
SELECT key, value, created_at, updated_at FROM imported.statistics;

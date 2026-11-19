INSERT INTO main.quick_search_click_stats (query_norm, path_norm, click_count, created_at, updated_at)
SELECT query_norm, path_norm, click_count, created_at, updated_at FROM imported.quick_search_click_stats
WHERE true
ON CONFLICT(query_norm, path_norm) DO UPDATE SET
    click_count = excluded.click_count,
    updated_at = excluded.updated_at;

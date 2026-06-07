CREATE TEMP TABLE quick_search_click_stats_dedup AS
SELECT
    MIN(id) AS id,
    query_norm,
    path_norm,
    SUM(click_count) AS click_count,
    MIN(created_at) AS created_at,
    MAX(updated_at) AS updated_at
FROM quick_search_click_stats
GROUP BY query_norm, path_norm;
--> statement-breakpoint
DELETE FROM quick_search_click_stats;
--> statement-breakpoint
INSERT INTO quick_search_click_stats (
    id,
    query_norm,
    path_norm,
    click_count,
    created_at,
    updated_at
)
SELECT
    id,
    query_norm,
    path_norm,
    click_count,
    created_at,
    updated_at
FROM quick_search_click_stats_dedup;
--> statement-breakpoint
DROP TABLE quick_search_click_stats_dedup;
--> statement-breakpoint
CREATE UNIQUE INDEX `quick_search_click_stats_query_path_unique` ON `quick_search_click_stats` (`query_norm`,`path_norm`);

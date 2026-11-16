-- Deleted turn identities cannot prove whether an overlapping archive is the same usage.
SELECT EXISTS (
    SELECT 1 FROM temp_usage_archive AS local
    WHERE local.origin = 0 AND local.request_count > 0
      AND (EXISTS (
          SELECT 1 FROM temp_usage_archive AS restored
          WHERE restored.origin = 1 AND restored.request_count > 0
            AND restored.day = local.day
      ) OR EXISTS (
          SELECT 1 FROM temp_usage_live AS restored
          WHERE restored.origin = 1 AND restored.request_count > 0
            AND restored.day = local.day
      ))
    UNION ALL
    SELECT 1 FROM temp_usage_archive AS restored
    WHERE restored.origin = 1 AND restored.request_count > 0
      AND EXISTS (
          SELECT 1 FROM temp_usage_live AS local
          WHERE local.origin = 0 AND local.request_count > 0
            AND local.day = restored.day
      )
    UNION ALL
    SELECT 1 FROM (
        SELECT origin, day, sum(request_count) AS request_count
        FROM (
            SELECT 0 AS origin, day, request_count FROM main.usage_daily_rollups
            UNION ALL
            SELECT 1, day, request_count FROM imported.usage_daily_rollups
        ) GROUP BY origin, day
    ) AS cached
    WHERE cached.request_count > (
        SELECT coalesce(sum(request_count), 0) FROM temp_usage_live
        WHERE origin = cached.origin AND day = cached.day
    ) AND EXISTS (
        SELECT 1 FROM temp_usage_live WHERE origin = cached.origin AND day = cached.day
    ) AND NOT EXISTS (
        SELECT 1 FROM temp_usage_archive WHERE origin = cached.origin AND day = cached.day
    )
);

-- Capture archived totals before full import replaces statistics and before live turns merge.
CREATE TEMP TABLE temp_usage_live AS
SELECT 0 AS origin, date(t.created_at) AS day,
       coalesce(t.model_name, m.name, '—') AS model_name, coalesce(t.provider_name, p.name, '—') AS provider_name,
       count(*) AS request_count, sum(t.status = 'completed') AS success_count,
       coalesce(sum(t.input_tokens), 0) AS input_tokens,
       coalesce(sum(t.output_tokens), 0) AS output_tokens,
       coalesce(sum(t.cache_read_tokens), 0) AS cache_read_tokens,
       coalesce(sum(t.cache_write_tokens), 0) AS cache_write_tokens,
       coalesce(sum(t.reasoning_tokens), 0) AS reasoning_tokens,
       coalesce(sum(t.total_cost_micros), 0) AS total_cost_micros,
       coalesce(sum(t.unpriced_calls), 0) AS unpriced_count,
       coalesce(sum(t.ttft_ms), 0) AS sum_ttft_ms,
       coalesce(sum(t.duration_ms), 0) AS sum_duration_ms,
       count(t.ttft_ms) AS ttft_sample_count
FROM main.session_turns AS t
LEFT JOIN main.models AS m ON m.id = t.model_id
LEFT JOIN main.providers AS p ON p.id = m.provider_id
GROUP BY day, model_name, provider_name
UNION ALL
SELECT 1, date(t.created_at), coalesce(t.model_name, m.name, '—'), coalesce(t.provider_name, p.name, '—'),
       count(*), sum(t.status = 'completed'),
       coalesce(sum(t.input_tokens), 0), coalesce(sum(t.output_tokens), 0),
       coalesce(sum(t.cache_read_tokens), 0), coalesce(sum(t.cache_write_tokens), 0),
       coalesce(sum(t.reasoning_tokens), 0), coalesce(sum(t.total_cost_micros), 0),
       coalesce(sum(t.unpriced_calls), 0), coalesce(sum(t.ttft_ms), 0),
       coalesce(sum(t.duration_ms), 0), count(t.ttft_ms)
FROM imported.session_turns AS t
LEFT JOIN imported.models AS m ON m.id = t.model_id
LEFT JOIN imported.providers AS p ON p.id = m.provider_id
GROUP BY date(t.created_at), coalesce(t.model_name, m.name, '—'), coalesce(t.provider_name, p.name, '—');

CREATE TEMP TABLE temp_usage_archive AS
SELECT s.origin,
       json_extract(j.value, '$.day') AS day,
       json_extract(j.value, '$.model_name') AS model_name,
       json_extract(j.value, '$.provider_name') AS provider_name,
       json_extract(j.value, '$.request_count') AS request_count,
       json_extract(j.value, '$.success_count') AS success_count,
       json_extract(j.value, '$.input_tokens') AS input_tokens,
       json_extract(j.value, '$.output_tokens') AS output_tokens,
       json_extract(j.value, '$.cache_read_tokens') AS cache_read_tokens,
       json_extract(j.value, '$.cache_write_tokens') AS cache_write_tokens,
       json_extract(j.value, '$.reasoning_tokens') AS reasoning_tokens,
       json_extract(j.value, '$.total_cost_micros') AS total_cost_micros,
       json_extract(j.value, '$.unpriced_count') AS unpriced_count,
       json_extract(j.value, '$.sum_ttft_ms') AS sum_ttft_ms,
       json_extract(j.value, '$.sum_duration_ms') AS sum_duration_ms,
       json_extract(j.value, '$.ttft_sample_count') AS ttft_sample_count
FROM (
    SELECT 0 AS origin, value FROM main.statistics WHERE key = 'usage_rollup_baseline'
    UNION ALL
    SELECT 1, value FROM imported.statistics WHERE key = 'usage_rollup_baseline'
) AS s, json_each(s.value) AS j;

-- Older database-only backups can have durable days without the newer baseline key.
-- Without retired turn identities, infer legacy archives only on wholly retired days.
-- A live day with excess cached totals is rejected instead of guessing its provenance.
INSERT INTO temp_usage_archive
SELECT d.origin, d.day, d.model_name, d.provider_name,
       d.request_count - coalesce(l.request_count, 0),
       max(0, d.success_count - coalesce(l.success_count, 0)),
       max(0, d.input_tokens - coalesce(l.input_tokens, 0)),
       max(0, d.output_tokens - coalesce(l.output_tokens, 0)),
       max(0, d.cache_read_tokens - coalesce(l.cache_read_tokens, 0)),
       max(0, d.cache_write_tokens - coalesce(l.cache_write_tokens, 0)),
       max(0, d.reasoning_tokens - coalesce(l.reasoning_tokens, 0)),
       max(0, d.total_cost_micros - coalesce(l.total_cost_micros, 0)),
       max(0, d.unpriced_count - coalesce(l.unpriced_count, 0)),
       max(0, d.sum_ttft_ms - coalesce(l.sum_ttft_ms, 0)),
       max(0, d.sum_duration_ms - coalesce(l.sum_duration_ms, 0)),
       max(0, d.ttft_sample_count - coalesce(l.ttft_sample_count, 0))
FROM (
    SELECT 0 AS origin, * FROM main.usage_daily_rollups
    UNION ALL
    SELECT 1, * FROM imported.usage_daily_rollups
) AS d
LEFT JOIN temp_usage_live AS l ON l.origin = d.origin AND l.day = d.day
    AND l.model_name = d.model_name AND l.provider_name = d.provider_name
WHERE d.request_count > coalesce(l.request_count, 0)
  AND NOT EXISTS (SELECT 1 FROM temp_usage_live AS live_day
      WHERE live_day.origin = d.origin AND live_day.day = d.day)
  AND NOT EXISTS (SELECT 1 FROM temp_usage_archive AS a
      WHERE a.origin = d.origin AND a.day = d.day
        AND a.model_name = d.model_name AND a.provider_name = d.provider_name);

CREATE INDEX temp.temp_usage_live_day ON temp_usage_live(origin, day);
CREATE INDEX temp.temp_usage_archive_day ON temp_usage_archive(origin, day);

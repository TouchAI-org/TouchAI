INSERT INTO usage_daily_rollups (
    day, model_name, provider_name,
    request_count, success_count,
    input_tokens, output_tokens, cache_read_tokens, cache_write_tokens,
    reasoning_tokens, total_cost_micros, unpriced_count,
    sum_ttft_ms, sum_duration_ms, ttft_sample_count
)
SELECT day, model_name, provider_name,
       sum(request_count), sum(success_count),
       sum(input_tokens), sum(output_tokens), sum(cache_read_tokens), sum(cache_write_tokens),
       sum(reasoning_tokens), sum(total_cost_micros), sum(unpriced_count),
       sum(sum_ttft_ms), sum(sum_duration_ms), sum(ttft_sample_count)
FROM (
    SELECT date(t.created_at) AS day,
           coalesce(t.model_name, m.name, '—') AS model_name,
           coalesce(t.provider_name, p.name, '—') AS provider_name,
           count(*) AS request_count,
           sum(CASE WHEN t.status = 'completed' THEN 1 ELSE 0 END) AS success_count,
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
    FROM session_turns AS t
    LEFT JOIN models AS m ON m.id = t.model_id
    LEFT JOIN providers AS p ON p.id = m.provider_id
    GROUP BY day, model_name, provider_name
    UNION ALL
    SELECT json_extract(value, '$.day'),
           json_extract(value, '$.model_name'),
           json_extract(value, '$.provider_name'),
           json_extract(value, '$.request_count'),
           json_extract(value, '$.success_count'),
           json_extract(value, '$.input_tokens'),
           json_extract(value, '$.output_tokens'),
           json_extract(value, '$.cache_read_tokens'),
           json_extract(value, '$.cache_write_tokens'),
           json_extract(value, '$.reasoning_tokens'),
           json_extract(value, '$.total_cost_micros'),
           json_extract(value, '$.unpriced_count'),
           json_extract(value, '$.sum_ttft_ms'),
           json_extract(value, '$.sum_duration_ms'),
           json_extract(value, '$.ttft_sample_count')
    FROM json_each(coalesce((
        SELECT value FROM statistics WHERE key = 'usage_rollup_baseline'
    ), '[]'))
)
WHERE true
GROUP BY day, model_name, provider_name
ON CONFLICT(day, model_name, provider_name) DO UPDATE SET
    request_count = excluded.request_count,
    success_count = excluded.success_count,
    input_tokens = excluded.input_tokens,
    output_tokens = excluded.output_tokens,
    cache_read_tokens = excluded.cache_read_tokens,
    cache_write_tokens = excluded.cache_write_tokens,
    reasoning_tokens = excluded.reasoning_tokens,
    total_cost_micros = excluded.total_cost_micros,
    unpriced_count = excluded.unpriced_count,
    sum_ttft_ms = excluded.sum_ttft_ms,
    sum_duration_ms = excluded.sum_duration_ms,
    ttft_sample_count = excluded.ttft_sample_count;

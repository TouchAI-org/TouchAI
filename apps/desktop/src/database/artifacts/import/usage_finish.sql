INSERT INTO main.statistics (key, value)
SELECT 'usage_rollup_baseline', json_group_array(json_object(
    'day', day, 'model_name', model_name, 'provider_name', provider_name,
    'request_count', request_count, 'success_count', success_count,
    'input_tokens', input_tokens, 'output_tokens', output_tokens,
    'cache_read_tokens', cache_read_tokens, 'cache_write_tokens', cache_write_tokens,
    'reasoning_tokens', reasoning_tokens, 'total_cost_micros', total_cost_micros,
    'unpriced_count', unpriced_count, 'sum_ttft_ms', sum_ttft_ms,
    'sum_duration_ms', sum_duration_ms, 'ttft_sample_count', ttft_sample_count
)) FROM (
    SELECT day, model_name, provider_name,
           sum(request_count) AS request_count, sum(success_count) AS success_count,
           sum(input_tokens) AS input_tokens, sum(output_tokens) AS output_tokens,
           sum(cache_read_tokens) AS cache_read_tokens, sum(cache_write_tokens) AS cache_write_tokens,
           sum(reasoning_tokens) AS reasoning_tokens, sum(total_cost_micros) AS total_cost_micros,
           sum(unpriced_count) AS unpriced_count, sum(sum_ttft_ms) AS sum_ttft_ms,
           sum(sum_duration_ms) AS sum_duration_ms, sum(ttft_sample_count) AS ttft_sample_count
    FROM temp_usage_archive
    GROUP BY day, model_name, provider_name
) WHERE true
ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = datetime('now');
DROP TABLE temp.temp_usage_archive;
DROP TABLE temp.temp_usage_live;

-- Freeze completed totals before the detailed turns are removed. Future rollups
-- combine this baseline with live turns instead of overwriting the archived day.
INSERT INTO statistics (key, value)
SELECT 'usage_rollup_baseline', json_group_array(json_object(
    'day', day, 'model_name', model_name, 'provider_name', provider_name,
    'request_count', request_count, 'success_count', success_count,
    'input_tokens', input_tokens, 'output_tokens', output_tokens,
    'cache_read_tokens', cache_read_tokens, 'cache_write_tokens', cache_write_tokens,
    'reasoning_tokens', reasoning_tokens, 'total_cost_micros', total_cost_micros,
    'unpriced_count', unpriced_count, 'sum_ttft_ms', sum_ttft_ms,
    'sum_duration_ms', sum_duration_ms, 'ttft_sample_count', ttft_sample_count
)) FROM usage_daily_rollups WHERE true
ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = datetime('now');
DELETE FROM session_turns;
DELETE FROM message_parts WHERE type = 'llm_call';
UPDATE sessions SET status_badge_dismissed_turn_id = NULL;

/**
 * 临时演示数据脚本（不提交）：跑几轮真实对话，让用量页有内容可看。
 */

const MAGPIE_ENDPOINT = 'http://127.0.0.1:3425/v1';
const MAGPIE_MODEL = 'group/auto-deepseek-v4-1-flash';

const PROMPTS = [
    '用一句话介绍你自己。',
    '用 bash 计算 123456 * 789 并告诉我结果。',
    '用 bash 列出当前目录下的前 5 个文件。',
    '把下面这句话翻译成英文：上下文管理对长对话很重要。',
    '用 bash 计算 1 到 1000 的和。',
    '简单解释一下什么是 token 缓存命中。',
];

async function runSql(sql, params = []) {
    return browser.executeAsync(
        (statement, values, done) => {
            window.__TAURI_INTERNALS__
                .invoke('database_query', {
                    request: { sql: statement, params: values, method: 'run' },
                })
                .then((result) => done({ ok: true, result }))
                .catch((error) => done({ ok: false, error: String(error) }));
        },
        sql,
        params
    );
}

async function queryRows(sql, params = []) {
    return browser.executeAsync(
        (statement, values, done) => {
            window.__TAURI_INTERNALS__
                .invoke('database_query', {
                    request: { sql: statement, params: values, method: 'all' },
                })
                .then((result) => done({ ok: true, rows: result.rows }))
                .catch((error) => done({ ok: false, error: String(error) }));
        },
        sql,
        params
    );
}

describe('demo usage seeding', () => {
    it('records several real conversations', async () => {
        await browser.waitUntil(async () => {
            return browser.execute(() => Boolean(window.__TOUCHAI_E2E__?.sendPrompt));
        });

        await runSql(
            `INSERT OR IGNORE INTO providers (id, name, driver, api_endpoint, logo, enabled)
             VALUES (900, 'Magpie', 'openai-compatible', ?, 'openai', 1)`,
            [MAGPIE_ENDPOINT]
        );
        await runSql(
            `INSERT OR IGNORE INTO models (id, provider_id, name, model_id, is_default, context_limit)
             VALUES (900, 900, 'Auto DeepSeek V4.1 Flash', ?, 1, 1000000)`,
            [MAGPIE_MODEL]
        );
        await runSql('UPDATE models SET is_default = 0 WHERE id != 900');

        for (const [index, prompt] of PROMPTS.entries()) {
            const before = await queryRows(
                'SELECT coalesce(max(id), 0) AS id FROM session_turns'
            );
            const beforeId = Number(before.rows?.[0]?.id ?? 0);

            const sent = await browser.executeAsync((text, done) => {
                window.__TOUCHAI_E2E__.sendPrompt(text)
                    .then(() => done({ ok: true }))
                    .catch((error) => done({ ok: false, error: String(error) }));
            }, prompt);
            if (!sent?.ok) {
                throw new Error(`prompt ${index} failed: ${sent?.error}`);
            }

            await browser.waitUntil(
                async () => {
                    const rows = await queryRows(
                        `SELECT status FROM session_turns WHERE id > ? ORDER BY id DESC LIMIT 1`,
                        [beforeId]
                    );
                    const status = rows.rows?.[0]?.status;
                    return status === 'completed' || status === 'failed';
                },
                { timeout: 180000, timeoutMsg: `prompt ${index} did not finish` }
            );
        }

        const summary = await queryRows(`
            SELECT count(*) AS turns,
                   sum(input_tokens) AS input,
                   sum(output_tokens) AS output,
                   sum(cache_read_tokens) AS cacheRead,
                   sum(llm_call_count) AS calls,
                   sum(total_cost_micros) AS cost
            FROM session_turns
        `);
        const parts = await queryRows(
            "SELECT count(*) AS n FROM message_parts WHERE type = 'llm_call'"
        );
        const priced = await queryRows(
            'SELECT count(*) AS n FROM llm_metadata WHERE input_cost_per_million IS NOT NULL'
        );

        console.log(
            'DEMO_SUMMARY ' +
                JSON.stringify({
                    summary: summary.rows?.[0],
                    llmCallParts: parts.rows?.[0]?.n,
                    pricedModels: priced.rows?.[0]?.n,
                })
        );
    });
});

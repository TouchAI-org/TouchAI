/**
 * 用量可观测性的端到端验证。
 *
 * 这条用例走完整链路：真实对话 → AgentService 采集 → 落库 → 设置页渲染。
 * 它依赖本机的 magpie 网关（http://127.0.0.1:3425/v1），
 * 因为「供应商到底返不返回 usage」只能在真实请求里验证。
 */

const MAGPIE_ENDPOINT = 'http://127.0.0.1:3425/v1';
const MAGPIE_MODEL = 'group/auto-deepseek-v4-1-flash';

/** 在 webview 里执行一条 SQL，直接复用应用自身的数据库通道 */
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

async function seedMagpieProvider() {
    await runSql(
        `INSERT OR IGNORE INTO providers (id, name, driver, api_endpoint, logo, enabled)
                  VALUES (900, 'Magpie E2E', 'openai-compatible', ?, 'openai', 1)`,
        [MAGPIE_ENDPOINT]
    );
    await runSql(
        `INSERT OR IGNORE INTO models (id, provider_id, name, model_id, is_default, context_limit)
                  VALUES (900, 900, 'Auto Flash E2E', ?, 1, 1000000)`,
        [MAGPIE_MODEL]
    );
    // 只保留一个默认模型，避免别的默认模型抢走请求
    await runSql('UPDATE models SET is_default = 0 WHERE id != 900');
}

describe('TouchAI usage observability', () => {
    it('records provider-reported usage for a real conversation', async () => {
        await browser.waitUntil(async () => {
            return browser.execute(() => Boolean(window.__TOUCHAI_E2E__?.sendPrompt));
        });

        await seedMagpieProvider();

        const sent = await browser.executeAsync((done) => {
            window.__TOUCHAI_E2E__
                .sendPrompt('Reply with exactly: pong')
                .then(() => done({ ok: true }))
                .catch((error) => done({ ok: false, error: String(error) }));
        });
        if (!sent?.ok) {
            throw new Error(`sendPrompt failed: ${sent?.error ?? 'unknown'}`);
        }

        // 等回合落库并进入终态
        await browser.waitUntil(
            async () => {
                const result = await queryRows(
                    'SELECT status FROM session_turns ORDER BY id DESC LIMIT 1'
                );
                const status = result.rows?.[0]?.status;
                return status === 'completed' || status === 'failed';
            },
            { timeout: 120000, timeoutMsg: 'turn did not reach a terminal state' }
        );

        const turns = await queryRows(`SELECT id, status, input_tokens, output_tokens,
                                              cache_read_tokens, llm_call_count, ttft_ms, duration_ms
                                       FROM session_turns ORDER BY id DESC LIMIT 1`);
        const turn = turns.rows?.[0];
        if (!turn || Number(turn.input_tokens) <= 0) {
            const stats = await queryRows(
                "SELECT count(*) AS n FROM message_parts WHERE type = 'llm_call'"
            );
            // 区分两种情况：网关本身失败，还是用量没被采到
            throw new Error(
                `usage not recorded (status=${turn?.status}): turn=${JSON.stringify(
                    turn
                )} llmCallParts=${JSON.stringify(stats.rows)}`
            );
        }
        if (turn.status !== 'completed') {
            throw new Error(`turn finished as ${turn.status}, not completed`);
        }

        // 供应商确实返回了用量，并且被采到、落了库
        for (const field of ['input_tokens', 'output_tokens', 'llm_call_count']) {
            if (!(Number(turn[field]) > 0)) {
                throw new Error(`expected ${field} > 0, got ${turn[field]}`);
            }
        }
        for (const field of ['ttft_ms', 'duration_ms']) {
            if (turn[field] === null || turn[field] === undefined) {
                throw new Error(`expected ${field} to be recorded, got ${turn[field]}`);
            }
        }

        // 明细片段必须存在，且与回合计数一致
        const parts = await queryRows(
            "SELECT count(*) AS n FROM message_parts WHERE type = 'llm_call'"
        );
        if (Number(parts.rows?.[0]?.n) !== Number(turn.llm_call_count)) {
            throw new Error(
                `call parts (${parts.rows?.[0]?.n}) do not match llm_call_count (${turn.llm_call_count})`
            );
        }

        // 三层聚合一致性：回合合计 = 各 attempt 之和
        const mismatch = await queryRows(
            `SELECT t.id FROM session_turns t
             JOIN session_turn_attempts a ON a.turn_id = t.id
             GROUP BY t.id
             HAVING t.input_tokens != sum(a.input_tokens)
                OR t.output_tokens != sum(a.output_tokens)`
        );
        if ((mismatch.rows ?? []).length > 0) {
            throw new Error(
                `turn totals drifted from attempt sums: ${JSON.stringify(mismatch.rows)}`
            );
        }

        // 上下文分片统计落库
        const breakdown = await queryRows(
            'SELECT prompt_breakdown_json FROM session_turns ORDER BY id DESC LIMIT 1'
        );
        const parsed = JSON.parse(String(breakdown.rows?.[0]?.prompt_breakdown_json));
        if (!(Number(parsed.fragments?.platform) > 0)) {
            throw new Error(`prompt breakdown was not recorded: ${JSON.stringify(parsed)}`);
        }

        // 定价链路：模型目录必须带价，否则用量页只会显示「未定价」
        const priced = await queryRows(
            'SELECT count(*) AS n FROM llm_metadata WHERE input_cost_per_million IS NOT NULL'
        );
        if (!(Number(priced.rows?.[0]?.n) > 0)) {
            throw new Error('llm_metadata has no priced models');
        }
    });

    it('shows the recorded usage on the settings page', async () => {
        const mainWindowHandle = await browser.getWindowHandle();

        await browser.executeAsync((done) => {
            window.__TOUCHAI_E2E__
                .openSettingsWindow()
                .then(() => done({ ok: true }))
                .catch((error) => done({ ok: false, error: String(error) }));
        });

        let settingsHandle = null;
        await browser.waitUntil(async () => {
            for (const handle of await browser.getWindowHandles()) {
                if (handle === mainWindowHandle) continue;
                await browser.switchToWindow(handle);
                if ((await browser.getUrl()).includes('/settings')) {
                    settingsHandle = handle;
                    return true;
                }
            }
            await browser.switchToWindow(mainWindowHandle);
            return false;
        });

        if (!settingsHandle) {
            throw new Error('Unable to locate settings window handle.');
        }
        await browser.switchToWindow(settingsHandle);

        // 进入「用量统计」
        const usageNav = await $("[data-testid='settings-nav-usage']");
        await usageNav.waitForDisplayed();
        await usageNav.click();

        const section = await $("[data-testid='settings-usage-section']");
        await section.waitForDisplayed();

        // 等真正渲染出数据（概览卡 + 图表），而不是停在加载态
        await browser.waitUntil(
            async () => (await $$("[data-testid='settings-usage-chart']")).length > 0,
            { timeout: 60000, timeoutMsg: 'Usage page never rendered the chart' }
        );

        const overview = await $("[data-testid='settings-usage-overview']");
        await overview.waitForDisplayed();

        // 必须显示真实数字，而不是空状态或全 0
        const body = await section.getText();
        if (body.includes('还没有用量数据')) {
            throw new Error('Usage page rendered the empty state after a recorded conversation.');
        }
        if (!/\d/.test(body)) {
            throw new Error('Usage page rendered without any numeric metric.');
        }

        // 筛选与标题同排，不再单独占据一整块带边框的区域
        const rangeTrigger = await $("[data-testid='settings-usage-range-trigger']");
        await rangeTrigger.waitForDisplayed();

        // 图表图例就是「用量分布」，应当列出至少一个模型
        const legendRows = await $$("[data-testid='settings-usage-chart'] .truncate");
        if (legendRows.length === 0) {
            throw new Error('Usage chart rendered no legend rows.');
        }

        // 实时面板常驻（无任务时是等待态）
        const live = await $("[data-testid='settings-usage-live']");
        await live.waitForDisplayed();

        // 工具统计与热力图都在页面上
        await (await $("[data-testid='settings-usage-heatmap']")).waitForDisplayed();
        await (await $("[data-testid='settings-usage-tools']")).waitForDisplayed();

        // 明细保留已移到数据管理，用量页不应再有这个入口
        const retentionOnUsage = await $("[data-testid='settings-usage-retention-trigger']");
        if (await retentionOnUsage.isExisting()) {
            throw new Error('Retention control should live in Data management, not Usage.');
        }

        // 导出 CSV 已按产品要求移除
        const exportButton = await $("[data-testid='settings-usage-export']");
        if (await exportButton.isExisting()) {
            throw new Error('CSV export should have been removed.');
        }

        await browser.closeWindow();
        await browser.switchToWindow(mainWindowHandle);
    });
});

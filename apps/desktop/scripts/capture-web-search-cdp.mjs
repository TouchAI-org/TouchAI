// 真实 TouchAI 窗口的端到端截图（CDP 路径）。
//
// WebDriver 驱动 Tauri WebView 时会因 DevToolsActivePort 与窗口单例冲突导致 #app 不挂载，
// 这里改走应用自带的 remote-debugging-port，用 CDP 直接对 WebView2 截屏。
// 会话数据通过应用自身的 openSession 钩子加载，走完整渲染链路。
//
// 用法：node scripts/capture-web-search-cdp.mjs <outputDir>

import { spawn } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { fileURLToPath } from 'node:url';

const repoRoot = path.resolve(fileURLToPath(new URL('../../..', import.meta.url)));
const outputDir = path.resolve(process.argv[2] ?? path.join(repoRoot, '.screenshots'));

const APP_BINARY = path.join(
    process.env.TOUCHAI_CARGO_TARGET_DIR ?? 'F:\\cargo-target\\touchai-deepseek',
    'debug',
    'TouchAI.exe'
);
const REAL_DB = 'F:\\data\\touchai.db';
const CDP_PORT = 9222;

/** 指定已有会话 id 时直接加载它（用于排查旧会话的渲染）；否则自建一条种子会话。 */
const TARGET_SESSION_ID = process.env.TOUCHAI_CAPTURE_SESSION_ID
    ? Number(process.env.TOUCHAI_CAPTURE_SESSION_ID)
    : null;

const QUERY = 'DeepSeek V4 什么时候发布';

const SOURCES = [
    {
        id: 'deepseek-1',
        index: 1,
        title: 'Spring animations: physics based spring transitions',
        url: 'https://motion.dev/docs/spring',
        snippet: 'Spring animations are physics based and feel natural.',
        siteName: 'motion.dev',
    },
    {
        id: 'deepseek-2',
        index: 2,
        title: 'prefers-reduced-motion - CSS: Cascading Style Sheets',
        url: 'https://developer.mozilla.org/en-US/docs/Web/CSS/@media/prefers-reduced-motion',
        snippet: 'Detect a user preference for reduced motion.',
        siteName: 'developer.mozilla.org',
    },
    {
        id: 'deepseek-3',
        index: 3,
        title: 'useEffect: synchronizing with effects',
        url: 'https://react.dev/reference/react/useEffect',
        snippet: 'useEffect lets you synchronize a component with an external system.',
        siteName: 'react.dev',
    },
    {
        id: 'deepseek-4',
        index: 4,
        title: 'DeepSeek V4.1-Flash-1017 Release',
        url: 'https://api-docs.deepseek.com/news/news261017',
        snippet: 'DeepSeek-V4.1-Flash-1017 is here with search and fetch APIs.',
        siteName: 'api-docs.deepseek.com',
    },
    {
        id: 'deepseek-5',
        index: 5,
        title: 'Search & Fetch guide',
        url: 'https://api-docs.deepseek.com/guides/search',
        snippet: 'Search API finds web pages and returns structured results.',
        siteName: 'api-docs.deepseek.com',
    },
    {
        id: 'deepseek-6',
        index: 6,
        title: 'Models & Pricing',
        url: 'https://api-docs.deepseek.com/quick_start/pricing',
        snippet: 'Search and Fetch are billed per successful request.',
        siteName: 'api-docs.deepseek.com',
    },
];

const ANSWER = [
    // 故意用真实模型常见的「（[来源](url)）。」写法，验证会被规范成「。[来源](url)」
    `根据 DeepSeek 官方发布说明，**V4.1-Flash-1017** 于 2026 年 10 月 17 日发布（[motion.dev](${SOURCES[0].url})）。`,
    `同一次更新还开放了自研搜索引擎的 Search 与 Fetch 两个接口（[api-docs.deepseek.com](${SOURCES[3].url})）。`,
    '',
    '计费方式为按成功请求计费：',
    '',
    '- Search：$0.75 / 1000 次',
    '- Fetch：$0.75 / 1000 次',
    '',
    `详见 [Models & Pricing](${SOURCES[5].url})。`,
].join('\n');

function sleep(ms) {
    return new Promise((resolve) => setTimeout(resolve, ms));
}

function seed() {
    const db = new DatabaseSync(REAL_DB);

    for (const row of db.prepare("SELECT id FROM sessions WHERE session_id LIKE 'seed-%'").all()) {
        db.prepare('DELETE FROM messages WHERE session_id = ?').run(row.id);
        db.prepare('DELETE FROM sessions WHERE id = ?').run(row.id);
    }

    const sessionRowId = db
        .prepare(
            "INSERT INTO sessions (session_id, title, model, message_count, created_at, updated_at) VALUES (?, ?, 'deepseek', 3, datetime('now'), datetime('now'))"
        )
        .run(`seed-${Date.now()}`, QUERY).lastInsertRowid;

    const userMessageId = db
        .prepare(
            "INSERT INTO messages (session_id, role, created_at, updated_at) VALUES (?, 'user', datetime('now'), datetime('now'))"
        )
        .run(sessionRowId).lastInsertRowid;

    db.prepare(
        "INSERT INTO message_parts (message_id, type, content, data, sort_order, created_at, updated_at) VALUES (?, 'text', ?, '{}', 0, datetime('now'), datetime('now'))"
    ).run(userMessageId, QUERY);

    const callId = `call_seed_${Date.now()}`;

    // 工具调用必须挂在 role='tool_call' 的独立消息行上，
    // buildPersistedEntries 只从这类行里收集 toolCalls。
    const toolMessageId = db
        .prepare(
            "INSERT INTO messages (session_id, role, created_at, updated_at) VALUES (?, 'tool_call', datetime('now'), datetime('now'))"
        )
        .run(sessionRowId).lastInsertRowid;

    const toolData = {
        iteration: 1,
        output: [
            'Web search',
            `Query: ${QUERY}`,
            'Intent: general',
            `Results: ${SOURCES.length}`,
        ].join('\n'),
        status: 'success',
        duration_ms: 611,
        error_message: null,
        approval_state: 'none',
        approval_summary: null,
        conversation_semantic_json: JSON.stringify({
            action: 'search',
            target: `${QUERY} · DeepSeek`,
        }),
        structured_payload_json: JSON.stringify({
            kind: 'web_search_sources',
            provider: 'deepseek',
            query: QUERY,
            status: 'done',
            sources: SOURCES,
        }),
        tool_id: 'web_search',
        input: JSON.stringify({ query: QUERY, provider: 'deepseek' }),
        toolCallId: callId,
        toolKind: 'builtin',
    };

    db.prepare(
        "INSERT INTO message_parts (message_id, type, content, data, sort_order, created_at, updated_at) VALUES (?, 'tool_call', '', ?, 0, datetime('now'), datetime('now'))"
    ).run(toolMessageId, JSON.stringify(toolData));

    const assistantMessageId = db
        .prepare(
            "INSERT INTO messages (session_id, role, created_at, updated_at) VALUES (?, 'assistant', datetime('now'), datetime('now'))"
        )
        .run(sessionRowId).lastInsertRowid;

    db.prepare(
        "INSERT INTO message_parts (message_id, type, content, data, sort_order, created_at, updated_at) VALUES (?, 'text', ?, '{}', 0, datetime('now'), datetime('now'))"
    ).run(assistantMessageId, ANSWER);

    // 另建一条“搜索中”的会话：工具调用 status=executing 且无结构化载荷，
    // 用于验证骨架 + 扫光状态。
    const searchingSessionId = db
        .prepare(
            "INSERT INTO sessions (session_id, title, model, message_count, created_at, updated_at) VALUES (?, ?, 'deepseek', 2, datetime('now'), datetime('now'))"
        )
        .run(`seed-searching-${Date.now()}`, `${QUERY}（搜索中）`).lastInsertRowid;

    const searchingUserMessageId = db
        .prepare(
            "INSERT INTO messages (session_id, role, created_at, updated_at) VALUES (?, 'user', datetime('now'), datetime('now'))"
        )
        .run(searchingSessionId).lastInsertRowid;

    db.prepare(
        "INSERT INTO message_parts (message_id, type, content, data, sort_order, created_at, updated_at) VALUES (?, 'text', ?, '{}', 0, datetime('now'), datetime('now'))"
    ).run(searchingUserMessageId, QUERY);

    const searchingToolMessageId = db
        .prepare(
            "INSERT INTO messages (session_id, role, created_at, updated_at) VALUES (?, 'tool_call', datetime('now'), datetime('now'))"
        )
        .run(searchingSessionId).lastInsertRowid;

    db.prepare(
        "INSERT INTO message_parts (message_id, type, content, data, sort_order, created_at, updated_at) VALUES (?, 'tool_call', '', ?, 0, datetime('now'), datetime('now'))"
    ).run(
        searchingToolMessageId,
        JSON.stringify({
            iteration: 1,
            output: null,
            // persist 侧的状态枚举里 `pending` 会映射成运行中（executing）
            status: 'pending',
            duration_ms: null,
            error_message: null,
            approval_state: 'none',
            approval_summary: null,
            conversation_semantic_json: JSON.stringify({
                action: 'search',
                target: `${QUERY} · DeepSeek`,
            }),
            structured_payload_json: null,
            tool_id: 'web_search',
            input: JSON.stringify({ query: QUERY, provider: 'deepseek' }),
            toolCallId: `call_searching_${Date.now()}`,
            toolKind: 'builtin',
        })
    );

    db.close();
    return {
        sessionRowId: Number(sessionRowId),
        searchingSessionRowId: Number(searchingSessionId),
    };
}

async function cdpRaw(wsUrl, method, params = {}) {
    const ws = new WebSocket(wsUrl);
    await new Promise((resolve, reject) => {
        ws.onopen = resolve;
        ws.onerror = reject;
    });

    const result = await new Promise((resolve, reject) => {
        ws.onmessage = (event) => {
            const payload = JSON.parse(event.data);
            if (payload.id === 1) {
                if (payload.error) reject(new Error(JSON.stringify(payload.error)));
                else resolve(payload.result);
            }
        };
        ws.send(JSON.stringify({ id: 1, method, params }));
        setTimeout(() => reject(new Error(`CDP timeout: ${method}`)), 30000);
    });

    ws.close();
    return result;
}

async function main() {
    fs.mkdirSync(outputDir, { recursive: true });

    if (!fs.existsSync(REAL_DB)) {
        throw new Error(`database not found: ${REAL_DB}`);
    }

    const seeded = TARGET_SESSION_ID
        ? { sessionRowId: TARGET_SESSION_ID, searchingSessionRowId: null }
        : seed();
    console.log(`target session row ${seeded.sessionRowId}`);

    const app = spawn(APP_BINARY, [], {
        stdio: 'ignore',
        env: {
            ...process.env,
            TOUCHAI_E2E: '1',
            WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS:
                '--disable-features=msWebOOUI,msPdfOOUI,msSmartScreenProtection ' +
                `--remote-debugging-port=${CDP_PORT} ` +
                '--enable-features=msEdgeDevToolsWdpRemoteDebugging --no-sandbox --disable-gpu',
        },
    });

    const cleanup = () => {
        try {
            app.kill();
        } catch {
            // ignore
        }
    };
    process.on('exit', cleanup);

    try {
        await sleep(9000);

        const targets = await (await fetch(`http://127.0.0.1:${CDP_PORT}/json`)).json();
        const page =
            targets.find((t) => t.type === 'page' && /#\/$/.test(t.url)) ??
            targets.find((t) => t.type === 'page' && !t.url.includes('tray-menu'));
        if (!page) {
            console.log(`targets: ${JSON.stringify(targets.map((t) => t.url))}`);
            throw new Error('main window target not found');
        }

        const wsUrl = page.webSocketDebuggerUrl;
        await sleep(3000);

        const shoot = async (name) => {
            // 程序化改 scrollLeft 后合成器不一定会重新出帧，
            // 先等两帧再截，否则会拿到上一次的陈旧画面。
            await cdpRaw(wsUrl, 'Runtime.evaluate', {
                expression: `
                    new Promise((resolve) => {
                        requestAnimationFrame(() => requestAnimationFrame(() => resolve(true)));
                    })
                `,
                awaitPromise: true,
                returnByValue: true,
            });
            await sleep(250);

            const shot = await cdpRaw(wsUrl, 'Page.captureScreenshot', {
                format: 'png',
                fromSurface: true,
                captureBeyondViewport: false,
            });
            const target = path.join(outputDir, `${name}.png`);
            fs.writeFileSync(target, Buffer.from(shot.data, 'base64'));
            console.log(`saved ${target}`);
        };

        await cdpRaw(wsUrl, 'Page.enable');

        // 用 CDP 强制视口尺寸，而不是依赖窗口尺寸：
        // 应用的自动收缩策略会把搜索窗重新压回 60px 高，截出来只剩一条。
        await cdpRaw(wsUrl, 'Emulation.setDeviceMetricsOverride', {
            width: 900,
            height: 1150,
            deviceScaleFactor: 1,
            mobile: false,
        });

        // 先掉开窗口，让应用自己的布局计算也在大尺寸下跑一遍
        await cdpRaw(wsUrl, 'Runtime.evaluate', {
            expression: `
                (async () => {
                    const { getCurrentWindow } = await import('@tauri-apps/api/window');
                    const win = getCurrentWindow();
                    await win.setSize({ type: 'Logical', width: 900, height: 1150 });
                    await win.show();
                    return true;
                })()
            `,
            awaitPromise: true,
            returnByValue: true,
        });
        await sleep(1500);
        await shoot('01-app');

        // 加载种子会话
        const picked = await cdpRaw(wsUrl, 'Runtime.evaluate', {
            expression: `
                (async () => {
                    const bridge = window.__TOUCHAI_E2E__;
                    if (!bridge || typeof bridge.openSession !== 'function') {
                        return { ok: false, reason: 'openSession hook missing' };
                    }
                    await bridge.openSession(${seeded.sessionRowId});
                    return { ok: true };
                })()
            `,
            awaitPromise: true,
            returnByValue: true,
        });
        console.log(`picked: ${JSON.stringify(picked.result?.value)}`);
        await sleep(4500);

        // 会话加载后应用会按内容重算窗口尺寸，这里再撑一次
        await cdpRaw(wsUrl, 'Runtime.evaluate', {
            expression: `
                (async () => {
                    const { getCurrentWindow } = await import('@tauri-apps/api/window');
                    const win = getCurrentWindow();
                    await win.setSize({ type: 'Logical', width: 900, height: 1150 });
                    return true;
                })()
            `,
            awaitPromise: true,
            returnByValue: true,
        });
        await sleep(2500);

        // 重新施加一次视口尺寸，避免应用的尺寸重算把它覆盖掉
        await cdpRaw(wsUrl, 'Emulation.setDeviceMetricsOverride', {
            width: 900,
            height: 1150,
            deviceScaleFactor: 1,
            mobile: false,
        });
        await sleep(600);

        // 指定旧会话时先滚到顶部，否则只能看到最后一段正文
        if (TARGET_SESSION_ID) {
            await cdpRaw(wsUrl, 'Runtime.evaluate', {
                expression: `
                    (() => {
                        const scroller = document.querySelector('.custom-scrollbar, [data-testid="conversation-panel"], .conversation-panel');
                        const candidates = [scroller, document.scrollingElement, ...document.querySelectorAll('div')]
                            .filter((el) => el && el.scrollHeight > el.clientHeight + 40);
                        for (const el of candidates) el.scrollTop = 0;
                        return candidates.length;
                    })()
                `,
                returnByValue: true,
            });
            await sleep(1200);
        }

        const state = await cdpRaw(wsUrl, 'Runtime.evaluate', {
            expression: `
                ({
                    cards: document.querySelectorAll('[data-slot="web-search-source"]').length,
                    triggers: document.querySelectorAll('.web-search-sources__trigger').length,
                    citations: document.querySelectorAll('[data-slot="web-search-citation"]').length,
                    line: (document.querySelector('.web-search-sources__trigger .tool-call-log-line') || {}).textContent,
                })
            `,
            returnByValue: true,
        });
        console.log(`state: ${JSON.stringify(state.result?.value)}`);

        // 引用排版：模型写的「（[来源](url)）。」应被规范成「。[来源](url)」
        const citationLayout = await cdpRaw(wsUrl, 'Runtime.evaluate', {
            expression: `
                (() => {
                    const paras = Array.from(document.querySelectorAll('p'));
                    const target = paras.find((p) =>
                        p.querySelector('[data-slot="web-search-citation"]')
                    );
                    if (!target) return { ok: false, reason: 'no citation paragraph' };

                    const nodes = Array.from(target.childNodes);
                    const chipIndex = nodes.findIndex(
                        (n) => n.nodeType === 1 && n.matches?.('[data-slot="web-search-citation"]')
                    );
                    const before = chipIndex > 0 ? (nodes[chipIndex - 1].textContent || '') : '';
                    const after = chipIndex >= 0 && chipIndex < nodes.length - 1
                        ? (nodes[chipIndex + 1].textContent || '')
                        : '';

                    return {
                        ok: true,
                        textBeforeChip: before.slice(-6),
                        textAfterChip: after.slice(0, 6),
                        hasWrappingParen: before.endsWith('（') || after.startsWith('）'),
                    };
                })()
            `,
            returnByValue: true,
        });
        console.log(`citation layout: ${JSON.stringify(citationLayout.result?.value)}`);

        await shoot('03-web-search-cards');

        // 验证滚轮阻尼：一格 120px 应缓动到 60px，且不是瞬间到位
        const damping = await cdpRaw(wsUrl, 'Runtime.evaluate', {
            expression: `
                (async () => {
                    const rail = document.querySelector('[data-slot="web-search-sources"]');
                    if (!rail) return { ok: false };
                    rail.scrollLeft = 0;
                    const frame = () => new Promise((r) => requestAnimationFrame(r));
                    await frame();

                    rail.dispatchEvent(new WheelEvent('wheel', {
                        deltaY: 120, deltaX: 0, bubbles: true, cancelable: true,
                    }));

                    const samples = [];
                    for (let i = 0; i < 6; i += 1) {
                        await frame();
                        samples.push(Math.round(rail.scrollLeft * 10) / 10);
                    }
                    for (let i = 0; i < 40; i += 1) await frame();

                    return {
                        ok: true,
                        samples,
                        settled: Math.round(rail.scrollLeft * 10) / 10,
                    };
                })()
            `,
            awaitPromise: true,
            returnByValue: true,
        });
        console.log(`wheel damping: ${JSON.stringify(damping.result?.value)}`);
        await sleep(400);

        // 用真实滚轮滚到最右：验证能滑到尽头且尾部渐隐消失
        await cdpRaw(wsUrl, 'Runtime.evaluate', {
            expression: `
                (async () => {
                    const rail = document.querySelector('[data-slot="web-search-sources"]');
                    if (!rail) return { ok: false };
                    const frame = () => new Promise((r) => requestAnimationFrame(r));
                    for (let i = 0; i < 8; i += 1) {
                        rail.dispatchEvent(new WheelEvent('wheel', {
                            deltaY: 120, deltaX: 0, bubbles: true, cancelable: true,
                        }));
                    }
                    // 缓动是异步的，等它跑完再读数
                    for (let i = 0; i < 60; i += 1) await frame();
                    return {
                        ok: true,
                        scrollLeft: Math.round(rail.scrollLeft * 10) / 10,
                        max: rail.scrollWidth - rail.clientWidth,
                        hasEndFade: Boolean(document.querySelector('.web-search-sources__fade--end')),
                    };
                })()
            `,
            awaitPromise: true,
            returnByValue: true,
        }).then((r) => console.log(`wheel to end: ${JSON.stringify(r.result?.value)}`));
        await sleep(600);
        await shoot('04-rail-end');

        // 再用滚轮滚回最左：验证首卡不再被挡住
        await cdpRaw(wsUrl, 'Runtime.evaluate', {
            expression: `
                (async () => {
                    const rail = document.querySelector('[data-slot="web-search-sources"]');
                    if (!rail) return { ok: false };
                    const frame = () => new Promise((r) => requestAnimationFrame(r));
                    for (let i = 0; i < 12; i += 1) {
                        rail.dispatchEvent(new WheelEvent('wheel', {
                            deltaY: -120, deltaX: 0, bubbles: true, cancelable: true,
                        }));
                    }
                    for (let i = 0; i < 60; i += 1) await frame();
                    const first = rail.firstElementChild?.firstElementChild?.getBoundingClientRect();
                    const railRect = rail.getBoundingClientRect();
                    return {
                        ok: true,
                        scrollLeft: Math.round(rail.scrollLeft * 10) / 10,
                        firstCardLeft: first ? Math.round(first.left) : null,
                        railLeft: Math.round(railRect.left),
                        hasStartFade: Boolean(document.querySelector('.web-search-sources__fade--start')),
                    };
                })()
            `,
            awaitPromise: true,
            returnByValue: true,
        }).then((r) => console.log(`wheel back to start: ${JSON.stringify(r.result?.value)}`));
        await sleep(600);
        await shoot('05-rail-back-to-start');

        // 展开全部来源
        await cdpRaw(wsUrl, 'Runtime.evaluate', {
            expression: `
                (() => {
                    const rail = document.querySelector('[data-slot="web-search-sources"]');
                    if (rail) rail.scrollLeft = 0;
                    return true;
                })()
            `,
            returnByValue: true,
        });
        await sleep(600);

        // 悬停引用 chip 弹出预览（先滚到可见处，否则截不到）
        await cdpRaw(wsUrl, 'Runtime.evaluate', {
            expression: `
                (() => {
                    const chip = document.querySelector('[data-slot="web-search-citation"]');
                    if (!chip) return false;
                    chip.scrollIntoView({ block: 'center' });
                    return true;
                })()
            `,
            returnByValue: true,
        });
        await sleep(900);

        await cdpRaw(wsUrl, 'Runtime.evaluate', {
            expression: `
                (() => {
                    const chips = document.querySelectorAll('[data-slot="web-search-citation"] a');
                    const chip = chips[chips.length - 1];
                    if (!chip) return false;
                    chip.dispatchEvent(
                        new PointerEvent('pointerenter', { pointerType: 'mouse', bubbles: true })
                    );
                    return true;
                })()
            `,
            returnByValue: true,
        });
        await sleep(1100);
        await shoot('05-citation-preview');

        // 预览不得越出会裁剪它的祖先（正文列比窗口窄，按窗口夹取会溢出被裁）
        const bounds = await cdpRaw(wsUrl, 'Runtime.evaluate', {
            expression: `
                (() => {
                    const chip = document.querySelector('[data-slot="web-search-citation"]');
                    const preview = document.querySelector('[role="tooltip"]');
                    if (!chip || !preview) return { ok: false, reason: 'no preview' };

                    let left = 0;
                    let right = window.innerWidth;
                    let node = chip.parentElement;
                    while (node) {
                        const style = getComputedStyle(node);
                        const clips = [style.overflow, style.overflowX, style.overflowY].some(
                            (v) => /(auto|scroll|hidden)/.test(v ?? '')
                        );
                        if (clips) {
                            const rect = node.getBoundingClientRect();
                            left = Math.max(left, rect.left);
                            right = Math.min(right, rect.right);
                        }
                        node = node.parentElement;
                    }

                    const rect = preview.getBoundingClientRect();
                    const round = (n) => Math.round(n * 10) / 10;
                    return {
                        ok: true,
                        previewLeft: round(rect.left),
                        previewRight: round(rect.right),
                        clipLeft: round(left),
                        clipRight: round(right),
                        overflowRight: round(Math.max(0, rect.right - right)),
                        overflowLeft: round(Math.max(0, left - rect.left)),
                    };
                })()
            `,
            returnByValue: true,
        });
        console.log(`preview bounds: ${JSON.stringify(bounds.result?.value)}`);

        // 窄窗下引用会贴近右边界，这里才能真的压到夹取逻辑
        const resized = await cdpRaw(wsUrl, 'Runtime.evaluate', {
            expression: `
                (async () => {
                    const { getCurrentWindow } = await import('@tauri-apps/api/window');
                    await getCurrentWindow().setSize({ type: 'Logical', width: 560, height: 900 });
                    await new Promise((r) => setTimeout(r, 500));
                    return { innerWidth: window.innerWidth, innerHeight: window.innerHeight };
                })()
            `,
            awaitPromise: true,
            returnByValue: true,
        });
        console.log(`resized viewport: ${JSON.stringify(resized.result?.value)}`);
        await sleep(1200);
        await cdpRaw(wsUrl, 'Runtime.evaluate', {
            expression: `
                (() => {
                    const chips = document.querySelectorAll('[data-slot="web-search-citation"] a');
                    const chip = chips[chips.length - 1];
                    if (!chip) return false;
                    chip.dispatchEvent(
                        new PointerEvent('pointerenter', { pointerType: 'mouse', bubbles: true })
                    );
                    return true;
                })()
            `,
            returnByValue: true,
        });
        await sleep(1200);
        await shoot('08-preview-narrow');

        const narrowBounds = await cdpRaw(wsUrl, 'Runtime.evaluate', {
            expression: `
                (() => {
                    const preview = document.querySelector('[role="tooltip"]');
                    if (!preview) return { ok: false, reason: 'no preview' };

                    let node = preview.parentElement;
                    let clip = null;
                    while (node) {
                        const style = getComputedStyle(node);
                        if ([style.overflowX, style.overflowY].some((v) => /(auto|scroll|hidden)/.test(v))) {
                            clip = node.getBoundingClientRect();
                            break;
                        }
                        node = node.parentElement;
                    }

                    const rect = preview.getBoundingClientRect();
                    const round = (n) => Math.round(n * 10) / 10;
                    return {
                        ok: true,
                        previewLeft: round(rect.left),
                        previewRight: round(rect.right),
                        clipLeft: clip ? round(clip.left) : null,
                        clipRight: clip ? round(clip.right) : null,
                        overflowRight: clip ? round(Math.max(0, rect.right - clip.right)) : null,
                        overflowLeft: clip ? round(Math.max(0, clip.left - rect.left)) : null,
                    };
                })()
            `,
            returnByValue: true,
        });
        console.log(`preview bounds (narrow): ${JSON.stringify(narrowBounds.result?.value)}`);

        // 收起来源卡片
        await cdpRaw(wsUrl, 'Runtime.evaluate', {
            expression: `
                (() => {
                    const trigger = document.querySelector('.web-search-sources__trigger');
                    if (trigger) trigger.click();
                    return Boolean(trigger);
                })()
            `,
            returnByValue: true,
        });
        await sleep(900);
        await shoot('06-collapsed');

        // 搜索中状态：骨架 + 扫光
        if (seeded.searchingSessionRowId) {
            await cdpRaw(wsUrl, 'Runtime.evaluate', {
                expression: `
                    (async () => {
                        const bridge = window.__TOUCHAI_E2E__;
                        if (!bridge?.openSession) return { ok: false };
                        await bridge.openSession(${seeded.searchingSessionRowId});
                        return { ok: true };
                    })()
                `,
                awaitPromise: true,
                returnByValue: true,
            });
            await sleep(3500);

            const skeletonState = await cdpRaw(wsUrl, 'Runtime.evaluate', {
                expression: `
                    (() => {
                        const skeletons = document.querySelectorAll(
                            '[data-slot="web-search-skeleton"]'
                        );
                        const shine = document.querySelector('.web-search-sources__skeleton-shine');
                        const chip = document.querySelector('[data-slot="web-search-citation"] a');
                        return {
                            skeletons: skeletons.length,
                            shineAnimation: shine
                                ? getComputedStyle(shine).animationName
                                : null,
                            citationChipWidth: chip
                                ? Math.round(chip.getBoundingClientRect().width)
                                : null,
                        };
                    })()
                `,
                returnByValue: true,
            });
            console.log(`skeleton probe: ${JSON.stringify(skeletonState.result?.value)}`);
            await shoot('07-searching-skeleton');
        }
    } finally {
        cleanup();
    }
}

main().catch((error) => {
    console.error(error);
    process.exit(1);
});

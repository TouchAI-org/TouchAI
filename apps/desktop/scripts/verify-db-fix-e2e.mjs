// 端到端验收：真实窗口跑一次「一轮多个工具调用」的搜索，确认修复后不再丢写入。
//
// 跑在应用根目录副本上（.tmp-app-root），不污染真实库。
// 注意：会真的调用模型 API（一次请求，含多轮工具调用），产生少量费用。
// 检查项：
//   1. 控制台没有 database is locked / PersistenceProjector 失败
//   2. turn 最终状态是 completed（不是 streaming）
//   3. 没有 tool_call 片段卡在 pending/executing
//   4. 每个 tool_call 片段都拿到了 output（结果真的回写了）
//   5. 没有重复的 (message_id, sort_order)
//
// 用法：node scripts/verify-db-fix-e2e.mjs      成功退出码 0，失败为 1
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';

const APP_BINARY = path.join(
    process.env.TOUCHAI_CARGO_TARGET_DIR ?? 'F:\\cargo-target\\touchai-deepseek',
    'debug',
    'TouchAI.exe'
);
const REAL_DATA = 'F:\\data';
const REAL_ASSETS = 'F:\\assets';
const SCRATCH_ROOT = path.resolve('.tmp-app-root');
const DB_FILE = path.join(SCRATCH_ROOT, 'data', 'touchai.db');
const CDP_PORT = 9224;

const PROMPT =
    '请用 web 搜索同时查三件事：今天有什么科技新闻、今天 AI 行业有什么新闻、今天 A 股行情如何。分别用一句话总结，并给出链接。';

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function prepareScratchRoot() {
    fs.rmSync(SCRATCH_ROOT, { recursive: true, force: true });
    for (const dir of ['data', 'cache', 'logs']) {
        fs.mkdirSync(path.join(SCRATCH_ROOT, dir), { recursive: true });
    }
    for (const file of fs.readdirSync(REAL_DATA)) {
        fs.copyFileSync(path.join(REAL_DATA, file), path.join(SCRATCH_ROOT, 'data', file));
    }
    try {
        fs.symlinkSync(REAL_ASSETS, path.join(SCRATCH_ROOT, 'assets'), 'junction');
    } catch {
        fs.mkdirSync(path.join(SCRATCH_ROOT, 'assets'), { recursive: true });
    }
}

function readScratch(handler) {
    const db = new DatabaseSync(DB_FILE, { readOnly: true });
    try {
        return handler(db);
    } finally {
        db.close();
    }
}

prepareScratchRoot();

const before = readScratch((db) => ({
    turns: db.prepare('SELECT COUNT(*) AS n FROM session_turns').get().n,
    maxTurnId: db.prepare('SELECT COALESCE(MAX(id), 0) AS n FROM session_turns').get().n,
}));
console.log(`scratch db ready (turns=${before.turns}, maxTurnId=${before.maxTurnId})`);

const app = spawn(APP_BINARY, [], {
    stdio: 'ignore',
    env: {
        ...process.env,
        TOUCHAI_E2E: '1',
        TOUCHAI_APP_ROOT: SCRATCH_ROOT,
        WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS:
            '--disable-features=msWebOOUI,msPdfOOUI,msSmartScreenProtection ' +
            `--remote-debugging-port=${CDP_PORT} ` +
            '--enable-features=msEdgeDevToolsWdpRemoteDebugging --no-sandbox --disable-gpu',
    },
});

let nextId = 1;
const consoleErrors = [];

try {
    await sleep(10000);
    const targets = await (await fetch(`http://127.0.0.1:${CDP_PORT}/json`)).json();
    const page =
        targets.find((t) => t.type === 'page' && /#\/$/.test(t.url)) ??
        targets.find((t) => t.type === 'page' && !t.url.includes('tray-menu'));
    if (!page) throw new Error(`main window not found: ${JSON.stringify(targets)}`);

    const ws = new WebSocket(page.webSocketDebuggerUrl);
    await new Promise((resolve, reject) => {
        ws.onopen = resolve;
        ws.onerror = reject;
    });

    const pending = new Map();
    ws.onmessage = (event) => {
        const msg = JSON.parse(event.data);
        if (msg.id && pending.has(msg.id)) {
            const { resolve, reject } = pending.get(msg.id);
            pending.delete(msg.id);
            if (msg.error) reject(new Error(JSON.stringify(msg.error)));
            else resolve(msg.result);
        }
        if (msg.method === 'Runtime.consoleAPICalled') {
            const type = msg.params.type;
            if (type !== 'error' && type !== 'warning') return;
            const text = (msg.params.args ?? [])
                .map((a) => a.value ?? a.description ?? '')
                .join(' ');
            if (
                /database is locked|PersistenceProjector|Failed to persist|persistence/i.test(text)
            ) {
                consoleErrors.push(`[${type}] ${text.slice(0, 400)}`);
            }
        }
        if (msg.method === 'Runtime.exceptionThrown') {
            consoleErrors.push(
                `[exception] ${msg.params.exceptionDetails.exception?.description ?? ''}`.slice(
                    0,
                    400
                )
            );
        }
    };
    const cdp = (method, params = {}) =>
        new Promise((resolve, reject) => {
            const id = nextId++;
            pending.set(id, { resolve, reject });
            ws.send(JSON.stringify({ id, method, params }));
            setTimeout(() => {
                if (pending.has(id)) {
                    pending.delete(id);
                    reject(new Error(`CDP timeout: ${method}`));
                }
            }, 60000);
        });

    await cdp('Runtime.enable');
    console.log(`submitting: ${PROMPT}`);
    await cdp('Runtime.evaluate', {
        expression: `window.sendPrompt(${JSON.stringify(PROMPT)}), true`,
        returnByValue: true,
    });

    const startedAt = Date.now();
    let turnStatus = null;
    while (Date.now() - startedAt < 300000) {
        await sleep(5000);
        const row = readScratch((db) =>
            db.prepare('SELECT id, status FROM session_turns ORDER BY id DESC LIMIT 1').get()
        );
        const elapsed = Math.round((Date.now() - startedAt) / 1000);
        const parts = readScratch(
            (db) =>
                db.prepare("SELECT COUNT(*) AS n FROM message_parts WHERE type = 'tool_call'").get()
                    .n
        );
        console.log(`  t=${elapsed}s turn#${row.id} status=${row.status} toolParts=${parts}`);
        if (row.status !== 'streaming') {
            turnStatus = row;
            break;
        }
    }

    console.log(`\n--- turn result: ${JSON.stringify(turnStatus)} ---`);
    console.log(`--- console errors (${consoleErrors.length}) ---`);
    for (const line of consoleErrors) console.log(line);
} finally {
    try {
        app.kill();
    } catch {
        // ignore
    }
}

await sleep(1500);

const report = readScratch((db) => {
    const turn = db.prepare('SELECT * FROM session_turns ORDER BY id DESC LIMIT 1').get();
    const parts = db
        .prepare(
            `SELECT p.id, p.message_id, json_extract(p.data, '$.tool_id') AS tool_id,
                    json_extract(p.data, '$.status') AS status,
                    json_extract(p.data, '$.output') IS NULL AS output_missing,
                    (SELECT MIN(sort_order) FROM message_parts q WHERE q.message_id = p.message_id) AS row_first_order,
                    p.sort_order
             FROM message_parts p
             WHERE p.type = 'tool_call' AND p.message_id IN
                 (SELECT m.id FROM messages m WHERE m.session_id = ?)
             ORDER BY p.id`
        )
        .all(turn.session_id);
    const duplicates = db
        .prepare(
            `SELECT message_id, sort_order, COUNT(*) AS n FROM message_parts
             GROUP BY message_id, sort_order HAVING n > 1`
        )
        .all();
    return { turn, parts, duplicates };
});

console.log('\n=== acceptance report ===');
console.log(`turn status:            ${report.turn.status}`);
console.log(`turn error:             ${JSON.stringify(report.turn.error_message)}`);
console.log(`duplicate sort_order:   ${report.duplicates.length}`);
console.log(`tool parts in turn:     ${report.parts.length}`);
const stuck = report.parts.filter((p) => p.status === 'pending' || p.status === 'executing');
const missingOutput = report.parts.filter((p) => p.output_missing === 1);
console.log(
    `stuck (pending/exec):   ${stuck.length} ${stuck.map((p) => `#${p.id}:${p.tool_id}`).join(' ')}`
);
console.log(
    `missing output:         ${missingOutput.length} ${missingOutput
        .map((p) => `#${p.id}:${p.tool_id}`)
        .join(' ')}`
);
for (const part of report.parts) {
    console.log(
        `  part#${part.id} msg=${part.message_id} ${part.tool_id} status=${part.status} outputMissing=${part.output_missing} sortOrder=${part.sort_order}`
    );
}

const passed =
    report.turn.status === 'completed' &&
    report.duplicates.length === 0 &&
    stuck.length === 0 &&
    missingOutput.length === 0 &&
    consoleErrors.length === 0;
console.log(`\n${passed ? 'PASS' : 'FAIL'}`);
process.exit(passed ? 0 : 1);

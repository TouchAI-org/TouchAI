// 确定性复现「数据库保存失败」的并发写入冲突。
//
// 复现的是生产里真实存在的调用形状：一轮里模型并行发出多个工具调用，
// `runToolRound` 用 Promise.all 并发执行，每个都走
// `updateBuiltInToolLogByCallId` → `updateToolPart` → `db.transaction`
// 事务内「先 SELECT 再 UPDATE」。
//
// 在 WAL + BEGIN DEFERRED 下，两个并发事务各自拿到读快照后，
// 后写的那一个升级失败并抛 `database is locked`（busy_timeout 对此无效）。
//
// 跑在应用根目录的副本上，避免污染真实库。
// 用法：node scripts/repro-tx-concurrency.mjs [concurrency]
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';

const APP_BINARY = path.join(
    process.env.TOUCHAI_CARGO_TARGET_DIR ?? 'F:\\cargo-target\\touchai-deepseek',
    'debug',
    'TouchAI.exe'
);
const REAL_DATA = 'F:\\data';
const REAL_ASSETS = 'F:\\assets';
const SCRATCH_ROOT = path.resolve('.tmp-app-root');
const DB_FILE = path.join(SCRATCH_ROOT, 'data', 'touchai.db');
const CDP_PORT = 9223; // 避开与其他探针脚本抢端口
const CONCURRENCY = Number(process.argv[2] ?? 8);

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function prepareScratchRoot() {
    fs.rmSync(SCRATCH_ROOT, { recursive: true, force: true });
    for (const dir of ['data', 'cache', 'logs']) {
        fs.mkdirSync(path.join(SCRATCH_ROOT, dir), { recursive: true });
    }
    // 真实库的副本：schema、数据、迁移记录全部照搬
    for (const file of fs.readdirSync(REAL_DATA)) {
        fs.copyFileSync(path.join(REAL_DATA, file), path.join(SCRATCH_ROOT, 'data', file));
    }
    // 资源目录用符号链接指回真实目录，避免复制字体/二进制
    try {
        fs.symlinkSync(REAL_ASSETS, path.join(SCRATCH_ROOT, 'assets'), 'junction');
    } catch {
        fs.mkdirSync(path.join(SCRATCH_ROOT, 'assets'), { recursive: true });
    }
    console.log(`scratch root ready: ${SCRATCH_ROOT}`);
}

/** 页面内驱动：并发执行「先读后写」事务，返回每个事务的结局。 */
function concurrencyDriver(concurrency, drizzleUrl) {
    return `
        (async () => {
            const { db } = await import('/src/database/index.ts');
            const { messageParts } = await import('/src/database/schema.ts');
            const { updateToolPart } = await import('/src/database/queries/toolParts.ts');
            const { native } = await import('/src/services/NativeService/index.ts');
            const { eq } = await import(${JSON.stringify(drizzleUrl)});

            // 把每个事务的第一次查询拖慢，放大本来就存在的 IPC 窗口。
            // 不改语义：事务顺序、读后写形状、SQL 全部保持原样。
            const originalTxQuery = native.database.txQuery.bind(native.database);
            const delayed = new Set();
            native.database.txQuery = async (txId, request) => {
                const result = await originalTxQuery(txId, request);
                if (!delayed.has(txId)) {
                    delayed.add(txId);
                    await new Promise((r) => setTimeout(r, 80));
                }
                return result;
            };

            const rows = await db
                .select({ id: messageParts.id, callId: messageParts.tool_call_id })
                .from(messageParts)
                .where(eq(messageParts.tool_kind, 'builtin'))
                .limit(${concurrency})
                .all();

            const targets = rows.filter((row) => row.callId);
            if (targets.length === 0) return { ok: false, reason: 'no builtin tool parts to update' };

            const outcomes = await Promise.all(
                targets.map(async (row, index) => {
                    try {
                        await updateToolPart(
                            'builtin',
                            eq(messageParts.tool_call_id, row.callId),
                            { duration_ms: 1000 + index }
                        );
                        return { call: row.callId.slice(0, 24), ok: true };
                    } catch (error) {
                        // drizzle 把底层错误包在 cause 里，这里只取根因，避免打印整条 SQL
                        const cause = error?.cause;
                        return {
                            call: row.callId.slice(0, 24),
                            ok: false,
                            error: typeof cause === 'string' ? cause : String(cause),
                        };
                    }
                })
            );

            return {
                ok: true,
                concurrency: targets.length,
                failed: outcomes.filter((o) => !o.ok).length,
                outcomes,
            };
        })()
    `;
}

async function resolveDrizzleUrl() {
    const response = await fetch('http://localhost:1420/src/database/queries/toolParts.ts');
    const source = await response.text();
    const match = source.match(/from "([^"]*drizzle-orm[^"]*)"/);
    if (!match) throw new Error('failed to resolve drizzle-orm dev URL from vite');
    return match[1];
}

let nextId = 1;

function prepareScratchRootIfNeeded() {
    if (!fs.existsSync(DB_FILE)) prepareScratchRoot();
}

prepareScratchRootIfNeeded();

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
            }, 90000);
        });

    await cdp('Runtime.enable');

    // 确认连的是副本库，别打错目标
    const drizzleUrl = await resolveDrizzleUrl();
    console.log(`drizzle url: ${drizzleUrl}`);
    const target = await cdp('Runtime.evaluate', {
        expression: `(async () => {
            const { rawQuery } = await import('/src/database/index.ts');
            const rows = await rawQuery("SELECT COUNT(*) AS n FROM message_parts WHERE tool_kind = 'builtin'");
            return { builtinParts: rows[0]?.n ?? null };
        })()`,
        awaitPromise: true,
        returnByValue: true,
    });
    console.log(`db target: ${JSON.stringify(target.result?.value)}`);

    const result = await cdp('Runtime.evaluate', {
        expression: concurrencyDriver(CONCURRENCY, drizzleUrl),
        awaitPromise: true,
        returnByValue: true,
    });

    if (result.exceptionDetails) {
        console.log('=== in-page exception ===');
        console.log(result.exceptionDetails.exception?.description ?? result.exceptionDetails.text);
    }
    const value = result.result?.value;
    if (value?.outcomes) {
        const failed = value.outcomes.filter((o) => !o.ok);
        console.log(
            `\n=== ${failed.length}/${value.outcomes.length} transactions failed (concurrency ${value.concurrency}) ===`
        );
        for (const f of failed) console.log(`  ${f.call}: ${f.error}`);
        const ok = value.outcomes.filter((o) => o.ok).length;
        console.log(`=== ${ok} succeeded ===`);
    } else {
        console.log(JSON.stringify(value, null, 2));
    }
} finally {
    app.kill();
}

await sleep(500);

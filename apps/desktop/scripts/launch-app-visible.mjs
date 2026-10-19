// 启动应用并把窗口直接显示出来。
//
// 应用默认 `visible: false`，平时靠全局快捷键 / 托盘呼出。
// 调试或手工验收时不想等快捷键（或快捷键被占用），用这个脚本：
// 走 CDP 连上 WebView，调用窗口 API 显示 + 聚焦，并给一个方便看内容的高度。
//
// 用法：node scripts/launch-app-visible.mjs [width] [height]
import { spawn } from 'node:child_process';
import path from 'node:path';

const APP_BINARY = path.join(
    process.env.TOUCHAI_CARGO_TARGET_DIR ?? 'F:\\cargo-target\\touchai-deepseek',
    'debug',
    'TouchAI.exe'
);
const CDP_PORT = 9228;
const WIDTH = Number(process.argv[2] ?? 750);
const HEIGHT = Number(process.argv[3] ?? 900);

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

let nextId = 1;

/**
 * 页面里 `import('@tauri-apps/api/window')` 是裸模块名，会直接抛 TypeError，
 * 在 `awaitPromise` 下只表现为 `result.value === {}` —— 看着像“调用没生效”。
 * 所以要从 dev server 拿 Vite 改写后的真实 URL。
 */
async function resolveDevModuleUrl(needle, probeFile) {
    const response = await fetch(`http://localhost:1420${probeFile}`);
    const source = await response.text();
    const match = source.match(new RegExp(`"(/[^"]*${needle}[^"]*)"`));
    if (!match) throw new Error(`failed to resolve ${needle} from ${probeFile}`);
    return match[1];
}

const app = spawn(APP_BINARY, [], {
    stdio: 'ignore',
    // 必须 detached：否则本脚本退出时应用会跟着被杀（Start-Process 天然是分离的）。
    detached: true,
    env: {
        ...process.env,
        WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS:
            '--disable-features=msWebOOUI,msPdfOOUI,msSmartScreenProtection ' +
            `--remote-debugging-port=${CDP_PORT} ` +
            '--enable-features=msEdgeDevToolsWdpRemoteDebugging --no-sandbox --disable-gpu',
    },
});
app.unref();

await sleep(9000);

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
        }, 30000);
    });

await cdp('Runtime.enable');

const windowModuleUrl = await resolveDevModuleUrl(
    '@tauri-apps_api_window',
    '/src/composables/useWindowResize.ts'
);
console.log(`@tauri-apps/api/window -> ${windowModuleUrl}`);

const result = await cdp('Runtime.evaluate', {
    expression: `(async () => {
        const { getCurrentWindow } = await import(${JSON.stringify(windowModuleUrl)});
        const win = getCurrentWindow();
        const before = { visible: await win.isVisible(), innerWidth: window.innerWidth };
        await win.setSize({ type: 'Logical', width: ${WIDTH}, height: ${HEIGHT} });
        await win.show();
        // 聚焦可能不返回（窗口刚显示时拿不到焦点），不能让它阻塞整个流程
        void win.setFocus().catch(() => {});
        await new Promise((r) => setTimeout(r, 600));
        return { before, visible: await win.isVisible(), innerWidth: window.innerWidth, innerHeight: window.innerHeight };
    })()`,
    awaitPromise: true,
    returnByValue: true,
});

if (result.exceptionDetails) {
    console.error(
        `show failed: ${result.exceptionDetails.exception?.description ?? result.exceptionDetails.text}`
    );
    process.exit(1);
}
console.log(`window state: ${JSON.stringify(result.result?.value)}`);
console.log(`app PID: ${app.pid}`);

// 不关掉 WebSocket 的话 node 会一直守着这个句柄不退出，调用方看起来就是“卡死”。
ws.close();
process.exit(0);

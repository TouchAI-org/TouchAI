// 引用预览溢出的真实测量（不做 viewport 伪装）。
//
// 上一次排查有两点做错了，导致「窄窗」这一步实际没跑过：
//   1. 用 Emulation.setDeviceMetricsOverride 伪造视口，布局宽度不是真窗口宽度；
//   2. 页面里 `import('@tauri-apps/api/window')` 是裸模块名，直接抛错，
//      在 awaitPromise 下只表现为 `result.value === {}` ——
//      看着像「setSize 没生效」，其实是那段代码根本没执行。
// 这里改成：解析 Vite 改写后的真实 URL、改真窗口尺寸、并校验 innerWidth 确实变了；
// 同时不再只看第一个引用，而是挑最靠右的那个（夹取逻辑只有它会触发）。
//
// 用法：node scripts/probe-citation-overflow.mjs
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';

const APP_BINARY = path.join(
    process.env.TOUCHAI_CARGO_TARGET_DIR ?? 'F:\\cargo-target\\touchai-deepseek',
    'debug',
    'TouchAI.exe'
);
const CDP_PORT = 9225;
const OUT_DIR = path.resolve('.screenshots/citation-overflow');
const SESSION_ID = Number(process.env.TOUCHAI_PROBE_SESSION ?? 74);
const WIDTHS = (process.env.TOUCHAI_PROBE_WIDTHS ?? '750,600,500,420')
    .split(',')
    .map((value) => Number(value.trim()));

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/** 复刻组件里的 resolveClipRect，把边界和实际矩形都量出来。 */
function measureExpression(index) {
    return `
    (() => {
        const round = (n) => Math.round(n * 10) / 10;
        const rectOf = (el) => {
            const r = el.getBoundingClientRect();
            return { left: round(r.left), right: round(r.right), top: round(r.top), bottom: round(r.bottom), width: round(r.width), height: round(r.height) };
        };

        const chips = [...document.querySelectorAll('[data-slot="web-search-citation"]')];
        const chip = chips[${index}];
        if (!chip) return { ok: false, reason: 'chip #${index} missing' };
        const preview = chip.querySelector('[role="tooltip"]');
        if (!preview) return { ok: false, reason: 'no preview mounted on chip #${index}' };

        let left = 0;
        let top = 0;
        let right = window.innerWidth;
        let bottom = window.innerHeight;
        let node = chip.parentElement;
        const ancestors = [];
        while (node) {
            const style = getComputedStyle(node);
            const overflow = [style.overflow, style.overflowX, style.overflowY];
            const clips = overflow.some((v) => /(auto|scroll|hidden)/.test(v ?? ''));
            const r = node.getBoundingClientRect();
            ancestors.push({
                tag: node.tagName.toLowerCase(),
                cls: (node.className || '').toString().slice(0, 64),
                position: style.position,
                clips,
                rect: { left: round(r.left), right: round(r.right) },
                client: node.clientWidth,
                scroll: node.scrollWidth,
            });
            if (clips) {
                left = Math.max(left, r.left);
                top = Math.max(top, r.top);
                right = Math.min(right, r.right);
                bottom = Math.min(bottom, r.bottom);
            }
            node = node.parentElement;
        }

        const previewStyle = getComputedStyle(preview);
        const previewRect = preview.getBoundingClientRect();
        const chipRect = chip.getBoundingClientRect();
        const column = chip.closest('p') ?? chip.closest('li') ?? chip.parentElement;
        const columnRect = column?.getBoundingClientRect();

        return {
            ok: true,
            index: ${index},
            chipCount: chips.length,
            viewport: { innerWidth: window.innerWidth, innerHeight: window.innerHeight, dpr: window.devicePixelRatio },
            chip: rectOf(chip),
            preview: rectOf(preview),
            clip: { left: round(left), right: round(right), top: round(top), bottom: round(bottom) },
            computed: {
                left: previewStyle.left,
                marginLeft: previewStyle.marginLeft,
                maxWidth: previewStyle.maxWidth,
                width: previewStyle.width,
                position: previewStyle.position,
            },
            column: columnRect ? { tag: column.tagName.toLowerCase(), cls: (column.className || '').toString().slice(0, 50), right: round(columnRect.right), left: round(columnRect.left) } : null,
            overflowClipRight: round(Math.max(0, previewRect.right - right)),
            overflowClipLeft: round(Math.max(0, left - previewRect.left)),
            overflowViewportRight: round(Math.max(0, previewRect.right - window.innerWidth)),
            overflowColumnRight: columnRect ? round(Math.max(0, previewRect.right - columnRect.right)) : null,
            ancestors,
        };
    })()
    `;
}

let nextId = 1;

/**
 * 把裸模块名换成 Vite dev server 改写后的 URL。
 *
 * 页面里直接 `import('@tauri-apps/api/window')` 会抛 TypeError（无法解析裸模块名），
 * 而 `awaitPromise` 下这个 reject 只表现为 `result.result.value === {}`。
 */
async function resolveDevModuleUrl(needle, probeFile) {
    const response = await fetch(`http://localhost:1420${probeFile}`);
    const source = await response.text();
    const match = source.match(new RegExp(`"(/[^"]*${needle}[^"]*)"`));
    if (!match) throw new Error(`failed to resolve ${needle} from ${probeFile}`);
    return match[1];
}

fs.rmSync(OUT_DIR, { recursive: true, force: true });
fs.mkdirSync(OUT_DIR, { recursive: true });

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
app.on('exit', (code) => console.log(`APP exited with code ${code}`));

try {
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
            }, 90000);
        });

    const evaluate = async (expression, awaitPromise = false) => {
        const result = await cdp('Runtime.evaluate', {
            expression,
            awaitPromise,
            returnByValue: true,
        });
        if (result.exceptionDetails) {
            console.log(
                `  [eval error] ${result.exceptionDetails.exception?.description ?? result.exceptionDetails.text}`
            );
        }
        return result.result?.value;
    };

    await cdp('Runtime.enable');
    await cdp('Page.enable');

    // `@tauri-apps/api/window` 被 Vite 重写成带 hash 的 dep URL
    const windowModuleUrl = await resolveDevModuleUrl(
        '@tauri-apps_api_window',
        '/src/composables/useWindowResize.ts'
    );
    console.log(`@tauri-apps/api/window -> ${windowModuleUrl}`);

    console.log(
        `openSession(${SESSION_ID}): ${JSON.stringify(
            await evaluate(
                `(async () => {
                    const bridge = window.__TOUCHAI_E2E__;
                    if (!bridge?.openSession) return { ok: false, reason: 'no openSession' };
                    await bridge.openSession(${SESSION_ID});
                    return { ok: true };
                })()`,
                true
            )
        )}`
    );
    await sleep(4000);

    for (const width of WIDTHS) {
        console.log(`\n${'='.repeat(72)}\n=== requested window width ${width} ===`);

        const resized = await evaluate(
            `(async () => {
                const { getCurrentWindow } = await import(${JSON.stringify(windowModuleUrl)});
                const win = getCurrentWindow();
                const before = window.innerWidth;
                await win.setSize({ type: 'Logical', width: ${width}, height: 1000 });
                await new Promise((r) => setTimeout(r, 1000));
                return { before, after: window.innerWidth, height: window.innerHeight };
            })()`,
            true
        );
        console.log(`resize -> ${JSON.stringify(resized)}`);

        // 挑最靠右的引用：只有它会触发左边的夹取逻辑
        const chips = await evaluate(
            `[...document.querySelectorAll('[data-slot="web-search-citation"]')].map((n, i) => {
                const r = n.getBoundingClientRect();
                return { i, left: Math.round(r.left * 10) / 10, top: Math.round(r.top * 10) / 10 };
            })`
        );
        if (!chips?.length) {
            console.log('  no citation chips in this session');
            continue;
        }
        const rightmost = chips.reduce((acc, c) => (c.left > acc.left ? c : acc), chips[0]);
        const picked = [...new Set([chips[0].i, rightmost.i, chips[chips.length - 1].i])];
        console.log(
            `  chips=${chips.length} firstLeft=${chips[0].left} rightmostLeft=${rightmost.left} (chip #${rightmost.i})`
        );

        for (const index of picked) {
            await evaluate(
                `(() => {
                    const chip = document.querySelectorAll('[data-slot="web-search-citation"]')[${index}];
                    if (chip) chip.scrollIntoView({ block: 'center' });
                    return true;
                })()`
            );
            await sleep(800);
            await evaluate(
                `(() => {
                    const chip = document.querySelectorAll('[data-slot="web-search-citation"]')[${index}];
                    const link = chip?.querySelector('a');
                    if (!link) return false;
                    link.dispatchEvent(new PointerEvent('pointerenter', { pointerType: 'mouse', bubbles: true }));
                    return true;
                })()`
            );
            await sleep(1000);

            const value = await evaluate(measureExpression(index));
            if (!value?.ok) {
                console.log(`  chip #${index}: ${JSON.stringify(value)}`);
                continue;
            }
            console.log(
                `\n  --- chip #${index} (viewport ${value.viewport.innerWidth}x${value.viewport.innerHeight}) ---`
            );
            console.log(
                `  chip      : [${value.chip.left} .. ${value.chip.right}] top=${value.chip.top}`
            );
            console.log(
                `  preview   : [${value.preview.left} .. ${value.preview.right}] h=${value.preview.height} w=${value.preview.width}`
            );
            console.log(
                `  clipRect  : [${value.clip.left} .. ${value.clip.right}] top=${value.clip.top} bottom=${value.clip.bottom}`
            );
            console.log(`  column    : ${JSON.stringify(value.column)}`);
            console.log(`  computed  : ${JSON.stringify(value.computed)}`);
            console.log(
                `  OVERFLOW beyond clip   : right=${value.overflowClipRight} left=${value.overflowClipLeft}`
            );
            console.log(`  OVERFLOW beyond viewport: right=${value.overflowViewportRight}`);
            console.log(`  OVERFLOW beyond column : right=${value.overflowColumnRight}`);
            const clipping = value.ancestors.filter((a) => a.clips);
            console.log(
                `  clipping ancestors     : ${clipping
                    .map((a) => `${a.tag}.${a.cls.split(' ')[0]} [${a.rect.left}..${a.rect.right}]`)
                    .join('  ')}`
            );

            if (
                width === WIDTHS[0] ||
                value.overflowClipRight > 0 ||
                value.overflowViewportRight > 0
            ) {
                const shot = await cdp('Page.captureScreenshot', {
                    format: 'png',
                    fromSurface: true,
                    captureBeyondViewport: false,
                });
                const target = path.join(OUT_DIR, `w${width}-chip${index}.png`);
                fs.writeFileSync(target, Buffer.from(shot.data, 'base64'));
                console.log(`  screenshot: ${target}`);
            }
        }
    }
} finally {
    try {
        app.kill();
    } catch {
        // ignore
    }
}

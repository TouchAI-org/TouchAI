import assert from 'node:assert/strict';
import { readFile, writeFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { fileURLToPath, pathToFileURL } from 'node:url';

import {
    FONT_EXPECTED_SHA256,
    resolveVerifiedFontFile,
    sha256OfFile,
} from '../../e2e-tests/e2e-font.js';
// Browser layout regression: use the production template, CSS, messages and geometry owner.
// Native IPC and unrelated message renderers are isolated; this is not desktop E2E.
const root = fileURLToPath(new URL('../..', import.meta.url))
    .replaceAll('\\', '/')
    .replace(/\/$/, '');
const base = process.env.TOUCHAI_LAYOUT_OUTPUT;
assert.ok(base, 'Set TOUCHAI_LAYOUT_OUTPUT to an external scratch directory');
const require = createRequire(`${root}/package.json`);
const { build } = await import(pathToFileURL(require.resolve('vite')).href);
const { default: vue } = await import(pathToFileURL(require.resolve('@vitejs/plugin-vue')).href);
const { default: tailwind } = await import(
    pathToFileURL(require.resolve('@tailwindcss/vite')).href
);
const { chromium } = require('@playwright/test');
const view = await readFile(`${root}/src/views/SearchView/index.vue`, 'utf8');
const template = view.slice(view.indexOf('<template>'));
const surfaceStyle = view.slice(
    view.indexOf('    const searchSurfaceStyle ='),
    view.indexOf('    const pageContentMaxHeight =')
);
const waitMeasurement = view.slice(
    view.indexOf('    function collapsingQuickSearchHeight()'),
    view.indexOf('    async function startQuickSearchHandoffClose()')
);
const contentStyles = view.slice(
    view.indexOf('    const pageContentMaxHeight ='),
    view.indexOf('    const {\n        startDragging:')
);
const fixtureSource = await readFile(
    new URL('./searchWindowHeight.vue.tpl', import.meta.url),
    'utf8'
);
const fixture =
    fixtureSource
        .replaceAll('../../src', root + '/src')
        .replace('/* __SURFACE_STYLE__ */', surfaceStyle)
        .replace('/* __CONTENT_STYLES__ */', contentStyles)
        .replace('/* __MEASURE_CONTENT__ */', waitMeasurement) + template;

const nativeState = {
    defaults: { width: 750, height: 60 },
    currentWidth: 750,
    currentHeight: 60,
    heightMode: 'auto',
    monitorHost: true,
};
await writeFile(
    `${base}/probe-entry.ts`,
    "import {createApp} from 'vue';import {createPinia} from 'pinia';import App from 'probe:fixture.vue';import '" +
        root +
        "/src/styles/tailwind.css';const app=createApp(App);app.use(createPinia());app.mount('#probe');"
);
const modules = {
    'probe:fixture.vue': fixture,
    'probe:quicksearch': `import{h}from'vue';export default {render:()=>h('div',{style:{height:'520px'}},'Search results')};`,
    'probe:searchbar': `import{defineComponent,h}from'vue';export default defineComponent({setup(){return()=>h('div',{'data-testid':'search-bar',style:{height:'60px',background:'var(--color-background-primary)'}},'Input');}})`,
    'probe:native': `let s=${JSON.stringify(nativeState)};window.commits=[];const noop=async()=>{};export const native={window:{getSearchWindowState:async()=>s,setSearchWindowDefaults:noop,setSearchWindowMinSize:noop,setSearchWindowAllowHeightOverride:noop,resetSearchWindowBounds:async()=>{s.currentHeight=60},commitSearchPanelResize:async p=>{window.commits.push({t:performance.now(),height:p.to.height});if(window.rejectResizes)throw new Error('resize unavailable');await new Promise(r=>setTimeout(r,24));if(p.auto&&p.respectManualOverride!==false&&s.heightMode==='manual_override')return s;return s={...s,currentWidth:p.to.width,currentHeight:p.to.height,heightMode:p.auto?'auto':'manual_override'}},resizeWindowHeight:noop}};`,
    'probe:window': `const noop=async()=>()=>{};const w={outerPosition:async()=>({x:0,y:0}),outerSize:async()=>({width:846,height:1000}),setPosition:async()=>{},onMoved:noop,onResized:noop,onScaleChanged:noop,isMaximized:async()=>false};export const getCurrentWindow=()=>w;export const currentMonitor=async()=>({workArea:{position:{x:0,y:0},size:{width:1920,height:1000}}});`,
    'probe:settings': `import{ref}from'vue';const state={outputScrollBehavior:ref('follow_output'),initialize:async()=>{}};export const useSettingsStore=()=>state;`,
    'probe:log': `export const log=console;`,
    'probe:notification': `export const notify=async()=>{};`,
    'probe:clipboard': `export const clipboardService={writeText:async()=>{}};`,
    'probe:widget': `export const SHOW_WIDGET_TOOL_NAME='show-widget';`,
    'probe:empty': `import{defineComponent,h}from'vue';export default defineComponent({props:['content'],setup(p){return()=>h('div',{style:{whiteSpace:'pre-wrap'}},p.content)}});`,
};
const aliases = {
    '@services/NativeService': 'probe:native',
    '@tauri-apps/api/window': 'probe:window',
    '@/stores/settings': 'probe:settings',
    '@services/ObservabilityService': 'probe:log',
    '@services/NotificationService': 'probe:notification',
    '@/services/ClipboardService': 'probe:clipboard',
    '@/services/BuiltInToolService/tools/widgetTool': 'probe:widget',
    '@components/MarkdownContent.vue': 'probe:empty',
    '@components/AppIcon.vue': 'probe:empty',
};
const plugin = {
    name: 'height-probe',
    enforce: 'pre',
    resolveId(source) {
        if (source === `${base}/probe-entry.ts`) return `${base}/probe-entry.ts`;
        if (aliases[source]) return aliases[source];
        if (source.startsWith('probe:')) return source;
        if (/\/(ToolCallItem|WidgetFrame|ToolApprovalHistoryCard)\.vue$/.test(source))
            return 'probe:empty';
    },
    load(id) {
        return modules[id] ?? null;
    },
};
const result = await build({
    configFile: false,
    root,
    define: { 'process.env.NODE_ENV': '"production"' },
    plugins: [plugin, tailwind(), vue()],
    logLevel: 'warn',
    resolve: {
        dedupe: ['vue', 'motion-v', 'pinia'],
        alias: {
            ...aliases,
            '@': `${root}/src`,
            '@composables': `${root}/src/composables`,
            '@components': `${root}/src/components`,
            '@services': `${root}/src/services`,
        },
    },
    build: {
        write: false,
        minify: false,
        lib: { entry: `${base}/probe-entry.ts`, name: 'HeightProbe', formats: ['iife'] },
    },
});
const output = (Array.isArray(result) ? result[0] : result).output;
const bundle = output.find((f) => f.type === 'chunk').code;
const css = output
    .filter((f) => f.type === 'asset' && f.fileName.endsWith('.css'))
    .map((f) => f.source)
    .join('\n');
const fontFile =
    process.env.TOUCHAI_LAYOUT_FONT ??
    (await resolveVerifiedFontFile({ cacheDirectory: `${base}/fonts` }));
assert.equal(sha256OfFile(fontFile), FONT_EXPECTED_SHA256);
const font = await readFile(fontFile);
const browser = await chromium.launch({
    channel:
        process.env.TOUCHAI_LAYOUT_BROWSER ?? (process.platform === 'win32' ? 'msedge' : undefined),
    headless: true,
    args: ['--disable-background-timer-throttling'],
});
const results = [];
try {
    for (const width of [420, 750]) {
        for (const reducedMotion of ['no-preference', 'reduce']) {
            const page = await browser.newPage({
                viewport: { width: width + 96, height: 1000 },
                reducedMotion,
            });
            const errors = [];
            page.on('pageerror', (error) => errors.push(error.message));
            await page.route('https://layout.test/font.woff2', (route) =>
                route.fulfill({
                    body: font,
                    contentType: 'font/woff2',
                    headers: { 'Access-Control-Allow-Origin': '*' },
                })
            );
            await page.route('https://layout.test/', (route) =>
                route.fulfill({ body: '<div id="probe"></div>', contentType: 'text/html' })
            );
            await page.goto('https://layout.test/');
            await page.setContent(
                `<style>${css} @font-face{font-family:'TouchAI Source Han Serif SC';src:url('https://layout.test/font.woff2') format('woff2-variations');font-weight:200 900;}</style><div id="probe"></div>`
            );
            await page.evaluate(() => document.fonts.load('15px "TouchAI Source Han Serif SC"'));
            await page.addScriptTag({ content: bundle });
            const start = await page.evaluate(() => window.probe.start());
            await page.keyboard.press('Enter');
            const conversationFocus = await page.evaluate(() => {
                window.probe.focusConversation();
                const viewport = document.activeElement;
                const style = getComputedStyle(viewport);
                return {
                    scrollerFocused: viewport.matches('[data-slot="message-scroller"] section'),
                    boxShadow: style.boxShadow,
                    outlineWidth: style.outlineWidth,
                    outlineColor: style.outlineColor,
                    outlineStyle: style.outlineStyle,
                };
            });
            await page.screenshot({ path: `${base}/height-${width}-${reducedMotion}-loading.png` });
            assert.ok(
                conversationFocus.scrollerFocused,
                'the conversation retains keyboard scrolling'
            );
            assert.equal(
                conversationFocus.boxShadow,
                'none',
                'submitting from the keyboard does not frame the entire conversation with a focus ring'
            );
            assert.ok(
                conversationFocus.outlineWidth === '0px' ||
                    conversationFocus.outlineStyle === 'none' ||
                    conversationFocus.outlineColor === 'rgba(0, 0, 0, 0)',
                'the conversation has no visible outline'
            );
            const cancel = await page.evaluate(() => window.probe.cancel());
            await page.screenshot({
                path: `${base}/height-${width}-${reducedMotion}-cancelled.png`,
            });
            const stream = await page.evaluate(() => window.probe.stream());
            const approval = await page.evaluate(() => window.probe.approval());
            const reopened = await page.evaluate(() => window.probe.reopen());
            const tallerInput = await page.evaluate(() => window.probe.resizeInput(160));
            const restoredInput = await page.evaluate(() => window.probe.resizeInput(60));
            const handoff = await page.evaluate(() => window.probe.handoff());
            const failedResize = await page.evaluate(() => window.probe.failResize());
            const manual = await page.evaluate(() => window.probe.manual());
            const manualRemeasure = await page.evaluate(() => window.probe.remeasureManual());
            const maximized = await page.evaluate(() => window.probe.maximize());
            const commits = await page.evaluate(() => window.commits);
            const result = {
                width,
                reducedMotion,
                start,
                conversationFocus,
                cancel,
                reopened,
                tallerInput,
                restoredInput,
                handoff,
                failedResize,
                manual,
                manualRemeasure,
                maximized,
                stream,
                approval,
                commits,
                errors,
            };
            results.push(result);
            assert.deepEqual(errors, [], 'user opens a conversation without renderer failures');
            assert.ok(approval.focused, 'user can answer an approval from the keyboard');
            assert.ok(
                approval.samples.every(
                    (sample) => sample.cardScroll === 0 && sample.pageScroll === 0
                ),
                'user receives approval focus without scrolling the animated card or its layout'
            );
            assert.ok(
                Math.abs(start.card - cancel.card) <= 1,
                'user cancels before the first answer without a height jump'
            );
            assert.ok(
                stream.every((sample) => sample.toolbar >= 0),
                'user keeps the toolbar visible throughout streaming'
            );
            assert.ok(
                stream.every((sample) => Math.abs(sample.input + 1) <= 1),
                'user keeps the input at the card bottom throughout streaming'
            );
            assert.ok(
                Math.abs(reopened.height - start.card) <= 1,
                'user opens a short conversation without inheriting the previous viewport height'
            );
            assert.ok(
                Math.abs(reopened.card - start.card) <= 1,
                'user opens a short conversation and settles at its measured content height'
            );
            assert.ok(
                Math.abs(tallerInput.card - reopened.card - 100) <= 1 &&
                    Math.abs(restoredInput.card - reopened.card) <= 1,
                'user changes an input row height without clipping conversation content'
            );
            assert.ok(
                Math.abs(handoff.height - start.card) <= 1 &&
                    Math.abs(handoff.card - start.card) <= 1,
                'user submits from results without adding the collapsing list to the conversation height'
            );
            assert.equal(
                manual.card,
                850,
                'user keeps a manual size larger than the automatic limit'
            );
            assert.equal(failedResize.first, 1, 'one failed resize does not start a retry loop');
            assert.equal(
                failedResize.later,
                failedResize.first,
                'unchanged content does not retry a failed native resize'
            );
            assert.ok(
                manualRemeasure.every((sample) => Math.abs(sample.card - 850) <= 1),
                'direct remeasurement preserves manual height throughout animation'
            );
            assert.ok(
                maximized.page > 850 && Math.abs(maximized.input) <= 1,
                'user maximizes with the editor at the bottom of the full viewport'
            );
            await page.close();
        }
    }
} finally {
    await browser.close();
    await writeFile(`${base}/height-layout-results.json`, JSON.stringify(results, null, 2));
}
console.log(
    `PASS: ${results.length} width/motion combinations; cancellation, streaming and reopen geometry`
);

import assert from 'node:assert/strict';
import { writeFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { fileURLToPath, pathToFileURL } from 'node:url';

// Real browser layout and WAAPI, with only the native window boundary simulated.
const root = fileURLToPath(new URL('../..', import.meta.url))
    .replaceAll('\\', '/')
    .replace(/\/$/, '');
const outputDirectory = process.env.TOUCHAI_LAYOUT_OUTPUT;
assert.ok(outputDirectory, 'Set TOUCHAI_LAYOUT_OUTPUT to an external scratch directory');
const require = createRequire(`${root}/package.json`);
const { build } = await import(pathToFileURL(require.resolve('vite')).href);
const { default: vue } = await import(pathToFileURL(require.resolve('@vitejs/plugin-vue')).href);
const { chromium } = require('@playwright/test');
const boundary = `
let state={defaults:{width:750,height:60},currentWidth:750,currentHeight:60,heightMode:'auto',monitorHost:true};
const scale=window.devicePixelRatio;
let position={x:0,y:0},size={width:846*scale,height:1080*scale};
let moved=()=>{};
window.hostPosition=()=>position;
const noop=async()=>{};
export const native={window:{getSearchWindowState:async()=>({...state,monitorHost:window.monitorHost ?? true}),setSearchWindowDefaults:noop,setSearchWindowMinSize:noop,setSearchWindowAllowHeightOverride:noop,resetSearchWindowBounds:noop,commitSearchPanelResize:async({to})=>{
size={width:(to.width+96)*scale,height:1080*scale};
await new Promise(resolve=>setTimeout(resolve,24));
moved({payload:position});
state={...state,currentWidth:to.width,currentHeight:to.height};return state;}}};
export const getCurrentWindow=()=>({outerPosition:async()=>({...position}),outerSize:async()=>size,onMoved:async cb=>{moved=cb;return()=>{}},onResized:async()=>()=>{},onScaleChanged:async()=>()=>{},isMaximized:async()=>false,setPosition:async p=>{position={x:p.x,y:p.y};await new Promise(resolve=>setTimeout(resolve,24));moved({payload:position})}});
export const currentMonitor=async()=>({workArea:{position:{x:0,y:0},size:{width:1920*scale,height:1080*scale}}});`;
const fixture = `<script setup>
import {computed,nextTick,onMounted,ref} from 'vue';
import {useSearchWindowResize} from '${root}/src/views/SearchView/composables/useSearchWindowResize';
import SearchOverlayHost from '${root}/src/views/SearchView/components/SearchOverlayHost/index.vue';
const card=ref(null),editor=ref(null),trigger=ref(null),menu=ref(null),filter=ref(null),open=ref(false),reveal=ref(false),ready=ref(false),floats=ref(false);
const resize=useSearchWindowResize({target:ref(null),card,sessionCount:ref(1),quickSearchOpen:ref(false),defaultSize:ref({width:750,height:60}),ready});
const height=computed(()=>resize.cardHeight.value || 60);
let onRevealed;
function focusMenu(){filter.value.focus({preventScroll:true});onRevealed?.({accepted:document.activeElement===filter.value,visibility:getComputedStyle(filter.value).visibility});onRevealed=null}

const pause=ms=>new Promise(r=>setTimeout(r,ms));
onMounted(()=>{ready.value=true});
window.geometryProbe={
async moveHost(x,onAnchor){window.hostPosition().x=x;floats.value=onAnchor;await resize.syncWindowState();await nextTick()},
async beginResize(height){await resize.syncWindowState();await resize.playSessionExpandAnimation(height);const animation=card.value.getAnimations()[0];if(!animation)throw new Error('Expected a real card animation');await animation.ready;animation.pause();animation.currentTime=animation.effect.getTiming().duration/2;return {height:card.value.getBoundingClientRect().height,state:animation.playState}},
readResize(){return {bounds:card.value.getBoundingClientRect().toJSON(),height:resize.currentHeight.value,animating:resize.isCardGrowing.value,animations:card.value.getAnimations().length}},
async prepareHidden(){window.monitorHost=false;await resize.syncWindowState();await nextTick();return {panel:card.value.parentElement.getBoundingClientRect().toJSON(),card:card.value.getBoundingClientRect().toJSON()}},
async expand(interrupt=false){await pause(100);const samples=[];let done=false;const read=()=>{const r=card.value.getBoundingClientRect();samples.push({height:r.height,top:r.top,hostY:window.hostPosition().y,center:window.hostPosition().y+(r.top+r.height/2)*window.devicePixelRatio});if(!done)requestAnimationFrame(read)};read();await resize.playSessionExpandAnimation(660);if(interrupt){await pause(80);await resize.playSessionExpandAnimation(600)}await pause(500);done=true;return samples},
async showMenu(){const focused=new Promise(resolve=>onRevealed=resolve);reveal.value=false;open.value=true;await nextTick();await menu.value.refreshPosition();await new Promise(requestAnimationFrame);reveal.value=true;const focus=await focused;await pause(220);return {focus,card:card.value.getBoundingClientRect().toJSON(),editor:editor.value.getBoundingClientRect().toJSON(),menu:document.querySelector('[data-search-overlay-host]').getBoundingClientRect().toJSON()}},
async hideMenu(){open.value=false;await pause(200)}
};
</script><template>
<section :style="resize.panelStyle.value"><main ref="card" :style="{...resize.cardStyle.value,height:height+'px',background:'#faf9f6',display:'flex',flexDirection:'column',justifyContent:'end'}">
<div ref="editor" style="height:60px;flex-shrink:0;padding:12px;box-sizing:border-box"><button ref="trigger">Models</button></div>
</main></section>
<SearchOverlayHost ref="menu" :open="open" :reveal="reveal" :anchor="trigger" :position-anchor="editor" :left-align-element="card" :max-viewport-height="900" :min-viewport-left="resize.overlayMinViewportLeft.value" :max-viewport-right="resize.overlayMaxViewportRight.value" :overlay-on-anchor="floats" :gap="5" @revealed="focusMenu">
<div style="width:320px;height:384px;max-height:var(--search-overlay-max-height);max-width:var(--search-overlay-max-width);overflow:auto;background:#faf9f6;border:1px solid gray;box-sizing:border-box"><input ref="filter" aria-label="Filter models" /><div style="height:600px">Model list</div></div>
</SearchOverlayHost>
</template>`;
const modules = {
    'probe:fixture.vue': fixture,
    'probe:boundary': boundary,
    'probe:log': 'export const log=console;',
};
const aliases = {
    '@services/NativeService': 'probe:boundary',
    '@tauri-apps/api/window': 'probe:boundary',
    '@services/ObservabilityService': 'probe:log',
};
const entry = `${outputDirectory}/geometry-entry.ts`;
await writeFile(
    entry,
    `import{createApp,h,ref}from'vue';import{provideMotionPreferences}from'${root}/src/composables/useMotion';import App from'probe:fixture.vue';import '${root}/src/styles/motion.css';createApp(window.sharedMotionPolicy?{setup(){window.motionPolicy=provideMotionPreferences(ref('standard'),ref(true));return()=>h(App)}}:App).mount('#probe');`
);
const result = await build({
    root,
    configFile: false,
    logLevel: 'warn',
    define: { 'process.env.NODE_ENV': '"production"' },
    plugins: [
        {
            name: 'geometry-boundaries',
            enforce: 'pre',
            resolveId(id) {
                return aliases[id] ?? (id.startsWith('probe:') ? id : null);
            },
            load(id) {
                return modules[id] ?? null;
            },
        },
        vue(),
    ],
    resolve: {
        dedupe: ['vue', 'motion-v'],
        alias: { ...aliases, '@': `${root}/src`, '@composables': `${root}/src/composables` },
    },
    build: {
        write: false,
        minify: false,
        lib: { entry, name: 'GeometryProbe', formats: ['iife'] },
    },
});
const output = (Array.isArray(result) ? result[0] : result).output;
const bundle = output.find((file) => file.type === 'chunk').code;
const css = output
    .filter((file) => file.type === 'asset' && file.fileName.endsWith('.css'))
    .map((file) => file.source)
    .join('\n');
const browser = await chromium.launch({
    channel: process.platform === 'win32' ? 'msedge' : undefined,
    headless: true,
});
const reports = [];
const focusReports = [];
const edgeReports = [];
const motionReports = [];
try {
    const hiddenPage = await browser.newPage();
    await hiddenPage.setContent(
        `<style>${css}#probe{width:0;height:0}</style><div id="probe"></div>`
    );
    await hiddenPage.addScriptTag({ content: bundle });
    const hidden = await hiddenPage.evaluate(() => window.geometryProbe.prepareHidden());
    assert.equal(hidden.panel.width, 750, 'hidden native-sized panel has its accepted width');
    assert.equal(hidden.panel.height, 60, 'hidden native-sized panel has its accepted height');
    assert.equal(hidden.card.width, 750, 'hidden card can be measured before native show');
    await writeFile(`${outputDirectory}/hidden-geometry.json`, JSON.stringify(hidden, null, 2));
    await hiddenPage.close();
    for (const mode of ['no-preference', 'reduce', 'css-only', 'automatic-shared']) {
        const page = await browser.newPage({
            reducedMotion: mode === 'reduce' ? 'reduce' : 'no-preference',
        });
        await page.setContent(
            `<style>${css}.fixed{position:fixed}.inline-block{display:inline-block}</style><div id="probe"></div>`
        );
        if (mode === 'automatic-shared') {
            await page.evaluate(() => {
                window.sharedMotionPolicy = true;
                const now = performance.now.bind(performance);
                window.motionClockDelay = 0;
                performance.now = () => now() + window.motionClockDelay;
            });
        }
        await page.addScriptTag({ content: bundle });
        if (mode === 'css-only') {
            await page.evaluate(() =>
                document.documentElement.setAttribute('data-reduced-motion', '')
            );
        }
        if (mode === 'automatic-shared') {
            // Feed two delayed samples through the real shared pressure sampler.
            // The popup still uses real DOM, focus, CSS and animation timelines.
            for (let sample = 0; sample < 2; sample += 1) {
                await page.evaluate(() => (window.motionClockDelay += 200));
                await page.waitForTimeout(1100);
            }
            assert.deepEqual(
                await page.evaluate(() => ({
                    reduced: window.motionPolicy.reducedMotion.value,
                    duration: window.motionPolicy.duration(150),
                    css: document.documentElement.hasAttribute('data-reduced-motion'),
                })),
                { reduced: true, duration: 0, css: true },
                'Shared automatic policy suppresses both JavaScript and CSS before focus handoff'
            );
        }
        for (let opening = 0; opening < 2; opening += 1) {
            const { focus } = await page.evaluate(() => window.geometryProbe.showMenu());
            focusReports.push({ reducedMotion: mode, opening, ...focus });
            await page.evaluate(() => window.geometryProbe.hideMenu());
        }
        await page.close();
    }
    await writeFile(
        `${outputDirectory}/overlay-focus-results.json`,
        JSON.stringify(focusReports, null, 2)
    );
    for (const report of focusReports) {
        assert.equal(
            report.visibility,
            'visible',
            `The popup is visible at focus handoff (${report.reducedMotion}, opening ${report.opening})`
        );
        assert.ok(report.accepted, 'The popup receives keyboard focus when its entrance starts');
    }
    for (const scale of [1, 1.5]) {
        for (const hostX of [-180, 1800]) {
            for (const onAnchor of [false, true]) {
                const page = await browser.newPage({
                    viewport: { width: 846, height: 1080 },
                    deviceScaleFactor: scale,
                });
                await page.setContent(
                    `<style>${css}.fixed{position:fixed}.inline-block{display:inline-block}</style><div id="probe"></div>`
                );
                await page.addScriptTag({ content: bundle });
                await page.evaluate(
                    ({ x, onAnchor }) => window.geometryProbe.moveHost(x, onAnchor),
                    { x: hostX * scale, onAnchor }
                );
                const bounds = await page.evaluate(() => window.geometryProbe.showMenu());
                assert.ok(
                    bounds.menu.left + hostX >= 0,
                    `Overlay left stays on screen after dragging: ${JSON.stringify({ scale, hostX, onAnchor, ...bounds })}`
                );
                assert.ok(
                    bounds.menu.right + hostX <= 1920,
                    'Overlay right stays on screen after dragging'
                );
                assert.equal(bounds.card.width, 750, 'Off-screen dragging preserves card width');
                edgeReports.push({ scale, hostX, onAnchor, ...bounds });
                await page.close();
            }
        }
    }
    await writeFile(
        `${outputDirectory}/overlay-edge-results.json`,
        JSON.stringify(edgeReports, null, 2)
    );
    for (const scale of [1, 1.5]) {
        const page = await browser.newPage({
            viewport: { width: 846, height: 1080 },
            deviceScaleFactor: scale,
            reducedMotion: 'no-preference',
        });
        await page.setContent(`<style>${css}</style><div id="probe"></div>`);
        await page.addScriptTag({ content: bundle });
        let fromHeight = 60;
        // Pausing the browser's actual WAAPI timeline makes the mid-animation
        // preference change deterministic without replacing Animation with a mock.
        for (const height of [660, 180, 480]) {
            await page.emulateMedia({ reducedMotion: 'no-preference' });
            const mid = await page.evaluate(
                (height) => window.geometryProbe.beginResize(height),
                height
            );
            assert.equal(mid.state, 'paused');
            assert.ok(
                mid.height > Math.min(fromHeight, height) &&
                    mid.height < Math.max(fromHeight, height),
                'The preference changes during an unfinished resize'
            );
            await page.emulateMedia({ reducedMotion: 'reduce' });
            await page.waitForFunction(() => !window.geometryProbe.readResize().animating);
            const samples = await page.evaluate(async () => {
                const samples = [window.geometryProbe.readResize()];
                for (let frame = 0; frame < 4; frame += 1) {
                    await new Promise(requestAnimationFrame);
                    samples.push(window.geometryProbe.readResize());
                }
                return samples;
            });
            for (const sample of samples) {
                assert.equal(sample.animations, 0, 'Finished WAAPI effects are removed');
                assert.equal(sample.height, height, 'Native accepted height remains the target');
                assert.ok(
                    Math.abs(sample.bounds.height - height) <= 1,
                    'Cleanup keeps the final card height'
                );
                assert.ok(
                    Math.abs(sample.bounds.top + sample.bounds.height / 2 - 540) <= 1,
                    'Cleanup keeps the card centered'
                );
            }
            motionReports.push({ scale, fromHeight, height, mid, samples });
            fromHeight = height;
        }
        await page.close();
    }
    for (const width of [516, 846]) {
        for (const scale of [1, 1.5]) {
            for (const interrupt of [false, true]) {
                const page = await browser.newPage({
                    viewport: { width, height: 1080 },
                    deviceScaleFactor: scale,
                });
                await page.setContent(
                    `<style>${css}.fixed{position:fixed}.inline-block{display:inline-block}</style><div id="probe"></div>`
                );
                await page.addScriptTag({ content: bundle });
                const samples = await page.evaluate(
                    (interrupt) => window.geometryProbe.expand(interrupt),
                    interrupt
                );
                const maxCenterDrift = Math.max(
                    ...samples.map((sample) => Math.abs(sample.center - samples[0].center))
                );
                const menu = await page.evaluate(() => window.geometryProbe.showMenu());
                await page.evaluate(() => window.geometryProbe.hideMenu());
                const reopened = await page.evaluate(() => window.geometryProbe.showMenu());
                reports.push({ width, scale, interrupt, maxCenterDrift, samples, menu, reopened });
                await page.screenshot({
                    path: `${outputDirectory}/geometry-${width}-${scale}-${interrupt}.png`,
                });
                await page.close();
            }
        }
    }
} finally {
    await browser.close();
    await writeFile(
        `${outputDirectory}/motion-resize-results.json`,
        JSON.stringify(motionReports, null, 2)
    );
}
await writeFile(`${outputDirectory}/geometry-results.json`, JSON.stringify(reports, null, 2));
for (const report of reports) {
    assert.ok(
        report.maxCenterDrift <= 1,
        `Conversation centre moved ${report.maxCenterDrift}px at width ${report.width}`
    );
    for (const bounds of [report.menu, report.reopened]) {
        assert.ok(
            Math.abs(bounds.menu.left - bounds.card.left) <= 1,
            'Picker must align with the card edge'
        );
        assert.ok(bounds.menu.bottom <= 900, 'Picker must fit the hard viewport limit');
        assert.ok(
            bounds.menu.bottom <= bounds.editor.top - 4 ||
                bounds.menu.top >= bounds.editor.bottom + 4,
            'Picker must not overlap editor padding'
        );
    }
}
console.log(
    `PASS: ${reports.length} browser geometry cases; ${focusReports.length} popup focus cases; ${edgeReports.length} off-screen overlay cases; ${motionReports.length} mid-resize motion changes`
);

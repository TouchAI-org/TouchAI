import fs from 'node:fs/promises';
import { createServer } from 'node:http';
import { tmpdir } from 'node:os';
import path from 'node:path';

import {
    assertVisible,
    callE2eBridge,
    resetSearchSurface,
    switchToWindowContaining,
    useInterfaceLanguage,
    useProductFont,
    waitForE2eBridge,
    waitForTestIdDisplayed,
} from '../support/desktop.js';

const screenshots =
    process.env.TOUCHAI_PRIVACY_SCREENSHOTS_DIR ??
    path.join(process.env.TOUCHAI_TEST_TEMP ?? tmpdir(), 'privacy-hover');
const original = 'ada@example.test';
const message = `请联系 ${original}，处理订单 ORD-EXAMPLE-0042。`;
let server;
let providerId;
let previousDefaults;
let previousDefaultModels = [];
let sentPlaceholder = '';
let requestCount = 0;
const userMarkerSelector = '.user-text [data-testid="privacy-protected-text"]';

async function waitForUserMarker() {
    const marker = await browser.$(userMarkerSelector);
    await marker.waitForDisplayed();
    return marker;
}

async function query(sql, params = [], method = 'run') {
    return browser.execute(
        async (request) => window.__TAURI_INTERNALS__.invoke('database_query', { request }),
        { sql, params, method }
    );
}

async function openMatchingRecord(direction, expectedLeft, expectedRight) {
    const rows = await browser.$$(
        `[data-testid="privacy-protection-record"][data-direction="${direction}"]`
    );
    for (const row of rows) {
        const action = await row.$('[data-testid="privacy-protection-record-open"]');
        await action.scrollIntoView();
        await action.click();
        const panel = await waitForTestIdDisplayed('privacy-protection-details');
        await browser.waitUntil(
            async () => (await panel.$$('[data-testid="privacy-protection-stage"]')).length === 2,
            { timeoutMsg: `The ${direction} record details did not finish loading.` }
        );
        const frames = await panel.$$('[data-testid="privacy-protection-stage"]');
        const left = await frames[0].getText();
        const right = await frames[1].getText();
        if (left.includes(expectedLeft) && right.includes(expectedRight)) {
            return { action, panel, left, right };
        }
        await action.click();
    }
    throw new Error(`No ${direction} record contains the request value.`);
}

async function setCardWidth(width) {
    const currentWidth = await browser.execute(
        () =>
            document.querySelector('[data-testid="search-view-card"]').getBoundingClientRect().width
    );
    if (Math.abs(currentWidth - width) <= 2) return;
    const label = { 420: '小', 750: '常规', 938: '大' }[width];
    assertVisible(Boolean(label), `Unsupported product window preset: ${width}px.`);
    await callE2eBridge('openSettingsWindow');
    await switchToWindowContaining('/settings');
    await (await waitForTestIdDisplayed('settings-nav-general')).click();
    const selector = await browser.$(
        '[data-settings-search-target="window-size"] [role="combobox"]'
    );
    await selector.click();
    await browser.waitUntil(async () => (await selector.getAttribute('aria-expanded')) === 'true', {
        timeoutMsg: 'The product window-size selector did not open.',
    });
    const popupId = await selector.getAttribute('aria-controls');
    const popup = await browser.$(`[id="${popupId}"]`);
    await popup.waitForDisplayed();
    const options = await popup.$$('[role="option"]');
    const labels = [];
    let selected;
    for (const option of options) {
        const text = (await option.getText()).trim();
        labels.push(text);
        if (text === label) selected = option;
    }
    assertVisible(
        Boolean(selected),
        `The ${label} window preset is unavailable: ${labels.join(', ')}.`
    );
    await selected.click();
    const preset = { 420: 'small', 750: 'normal', 938: 'large' }[width];
    await browser.waitUntil(
        async () =>
            (
                await query(
                    'SELECT value FROM settings WHERE key = ?',
                    ['search_window_size_preset'],
                    'get'
                )
            ).rows[0]?.value === preset,
        { timeoutMsg: 'The product window-size preference was not saved.' }
    );
    await browser.execute(async () =>
        window.__TAURI_INTERNALS__.invoke('plugin:window|hide', { label: 'settings' })
    );
    await waitForE2eBridge();
    await browser.execute(async () => window.__TAURI_INTERNALS__.invoke('show_search_window'));
    await browser.waitUntil(
        async () =>
            browser.execute((expected) => {
                const card = document.querySelector('[data-testid="search-view-card"]');
                return card && Math.abs(card.getBoundingClientRect().width - expected) <= 2;
            }, width),
        { timeoutMsg: `The actual search card did not settle at ${width}px.` }
    );
}

async function readTooltipLayout(markerSelector = userMarkerSelector) {
    return browser.execute((selector) => {
        const tooltip = document.querySelector('[data-testid="privacy-protection-tooltip"]');
        const card = document.querySelector('[data-testid="search-view-card"]');
        const bounds = tooltip.getBoundingClientRect();
        const status = tooltip.querySelector('[data-testid="privacy-protection-shield"]');
        const rule = tooltip.querySelector('[data-testid="privacy-protection-tag"]');
        const marker = document.querySelector(selector);
        const markerStyle = getComputedStyle(marker);
        const value = tooltip.querySelector('[data-testid="privacy-protection-placeholder"]');
        const row = value.parentElement;
        const textRange = document.createRange();
        textRange.selectNodeContents(value);
        const surfaceStyle = getComputedStyle(tooltip);
        const naturalWidth =
            row.firstElementChild.getBoundingClientRect().width +
            textRange.getBoundingClientRect().width +
            Number.parseFloat(getComputedStyle(row).columnGap) +
            Number.parseFloat(surfaceStyle.paddingLeft) +
            Number.parseFloat(surfaceStyle.paddingRight) +
            Number.parseFloat(surfaceStyle.borderLeftWidth) +
            Number.parseFloat(surfaceStyle.borderRightWidth);
        return {
            tooltip: bounds.toJSON(),
            naturalWidth,
            contentFits: tooltip.scrollWidth <= tooltip.clientWidth,
            ruleBeforeStatus:
                rule.getBoundingClientRect().right <= status.getBoundingClientRect().left,
            fontFamilies: [
                status,
                ...tooltip.querySelectorAll('[data-testid="privacy-protection-tag"]'),
                tooltip.querySelector('[data-testid="privacy-protection-placeholder"]'),
            ].map((element) => getComputedStyle(element).fontFamily),
            underline: {
                thickness: Number.parseFloat(markerStyle.textDecorationThickness),
                color: markerStyle.textDecorationColor,
                style: markerStyle.textDecorationStyle,
            },
            marker: {
                cursor: markerStyle.cursor,
                outlineStyle: markerStyle.outlineStyle,
                boxShadow: markerStyle.boxShadow,
                borderWidths: [
                    markerStyle.borderTopWidth,
                    markerStyle.borderRightWidth,
                    markerStyle.borderBottomWidth,
                    markerStyle.borderLeftWidth,
                ].map(Number.parseFloat),
                focusVisible: marker.matches(':focus-visible'),
            },
            card: card.getBoundingClientRect().toJSON(),
            viewport: { width: innerWidth, height: innerHeight },
            rowCount: tooltip.firstElementChild.children.length,
        };
    }, markerSelector);
}

function assertMarkerFrameless({ marker }) {
    assertVisible(marker.cursor === 'text', 'The annotation does not use the normal text cursor.');
    assertVisible(
        marker.outlineStyle === 'none' &&
            marker.boxShadow === 'none' &&
            marker.borderWidths.every((width) => width === 0),
        'A rectangular frame surrounds the protected text.'
    );
}

function assertTooltipFits(layout) {
    const { tooltip, card } = layout;
    assertMarkerFrameless(layout);
    assertVisible(layout.rowCount === 2, 'The tooltip does not have exactly two compact rows.');
    assertVisible(layout.contentFits, 'The tooltip content overflows its floating surface.');
    assertVisible(
        Math.abs(tooltip.width - layout.naturalWidth) <= 3,
        'The tooltip width does not follow the natural width of its second row.'
    );
    assertVisible(
        layout.ruleBeforeStatus,
        'Rule labels are not on the left of the masking status.'
    );
    assertVisible(
        layout.fontFamilies.every((family) => family.includes('TouchAI Source Han Serif SC')),
        'Some preview text does not use the product serif font.'
    );
    assertVisible(
        layout.underline.thickness > 0 && layout.underline.thickness < 1,
        'The annotation underline is not a hairline.'
    );
    assertVisible(
        tooltip.left >= card.left - 1 &&
            tooltip.top >= card.top - 1 &&
            tooltip.right <= card.right + 1 &&
            tooltip.bottom <= card.bottom + 1,
        `The tooltip leaves the visible native card: ${JSON.stringify(layout)}`
    );
}

async function readFocusOutlines(rootSelector = 'body') {
    await browser.keys('Tab');
    return browser.execute(async (selector) => {
        const root = document.querySelector(selector);
        const previous = document.activeElement;
        const controls = [
            ...root.querySelectorAll(
                'button, a[href], input, textarea, select, [tabindex], [contenteditable="true"]'
            ),
        ].filter(
            (element) =>
                element.getClientRects().length > 0 &&
                getComputedStyle(element).visibility === 'visible' &&
                !element.matches(':disabled, [aria-disabled="true"]')
        );
        const outlines = [];
        async function settle(control) {
            await Promise.all(control.getAnimations().map((animation) => animation.finished));
        }
        for (const control of controls) {
            control.blur();
            await settle(control);
            const restingStyle = getComputedStyle(control);
            const restingColors = [restingStyle.backgroundColor, restingStyle.color];
            control.focus({ preventScroll: true });
            if (document.activeElement !== control) continue;
            await settle(control);
            const style = getComputedStyle(control);
            outlines.push({
                tag: control.tagName,
                testId: control.getAttribute('data-testid'),
                role: control.getAttribute('role'),
                outlineStyle: style.outlineStyle,
                outlineColor: style.outlineColor,
                focusVisible: control.matches(':focus-visible'),
                colorsChanged:
                    restingColors[0] !== style.backgroundColor || restingColors[1] !== style.color,
            });
        }
        if (previous instanceof HTMLElement) previous.focus({ preventScroll: true });
        return outlines;
    }, rootSelector);
}

describe('given a real protected request in the desktop conversation', () => {
    before(async () => {
        await fs.mkdir(screenshots, { recursive: true });
        server = createServer(async (request, response) => {
            const chunks = [];
            for await (const chunk of request) chunks.push(chunk);
            const body = JSON.parse(Buffer.concat(chunks).toString('utf8'));
            const user = body.messages.filter((item) => item.role === 'user').at(-1);
            const text =
                typeof user.content === 'string'
                    ? user.content
                    : user.content.map((part) => part.text ?? '').join('');
            sentPlaceholder = text.match(/\{\{EMAIL_[0-9a-f]{16}\}\}/)?.[0] ?? '';
            requestCount += 1;
            if (!sentPlaceholder || text.includes(original)) {
                response.writeHead(400, { 'content-type': 'application/json' });
                response.end(JSON.stringify({ error: { message: 'The request was not masked.' } }));
                return;
            }
            response.writeHead(200, { 'content-type': 'text/event-stream' });
            for (const content of [
                `已收到，我会联系 ${sentPlaceholder.slice(0, 10)}`,
                `${sentPlaceholder.slice(10)} 处理订单。`,
            ]) {
                response.write(
                    `data: ${JSON.stringify({ choices: [{ index: 0, delta: { content }, finish_reason: null }] })}\n\n`
                );
            }
            response.end(
                `data: ${JSON.stringify({ choices: [{ index: 0, delta: {}, finish_reason: 'stop' }] })}\n\ndata: [DONE]\n\n`
            );
        });
        await new Promise((resolve, reject) => {
            server.once('error', reject);
            server.listen(0, '127.0.0.1', resolve);
        });
        await waitForE2eBridge();
        await useInterfaceLanguage('zh-CN');
        await useProductFont();
        previousDefaults = await browser.execute(
            async () => (await window.__TOUCHAI_E2E__.getSearchWindowState()).defaults
        );
        previousDefaultModels = (
            await query('SELECT id FROM models WHERE is_default = 1', [], 'all')
        ).rows.map((row) => row.id);
        const inserted = await query(
            'INSERT INTO providers (name, driver, api_endpoint, logo, enabled) VALUES (?, ?, ?, ?, ?)',
            [
                'privacy-hover-test',
                'openai-compatible',
                `http://127.0.0.1:${server.address().port}/v1`,
                'openai',
                1,
            ]
        );
        providerId = inserted.lastInsertId;
        await query('UPDATE models SET is_default = 0 WHERE is_default = 1');
        await query(
            'INSERT INTO models (provider_id, name, model_id, is_default, context_limit, output_limit) VALUES (?, ?, ?, ?, ?, ?)',
            [providerId, 'Kimi K2', 'privacy-hover-test', 1, 8192, 512]
        );
        await callE2eBridge('setPrivacyFilterSettings', {
            enabled: true,
            useLocalModel: false,
        });
        await callE2eBridge('openSettingsWindow');
        await switchToWindowContaining('/settings');
        await (await waitForTestIdDisplayed('settings-nav-privacy-filter')).click();
        const enabled = await waitForTestIdDisplayed('privacy-filter-enabled-toggle');
        assertVisible(
            (await enabled.getAttribute('aria-checked')) === 'true',
            'The rule-based privacy fixture did not enable protection.'
        );
        const rules = await waitForTestIdDisplayed('privacy-filter-mode-rules');
        await browser.waitUntil(async () => rules.isEnabled(), {
            timeoutMsg: 'The rule-based privacy fixture did not reach the settings window.',
        });
        await browser.waitUntil(
            async () => {
                const saved = await query(
                    'SELECT value FROM settings WHERE key = ?',
                    ['privacy_filter_settings'],
                    'get'
                );
                const preferences = JSON.parse(saved.rows[0]?.value ?? '{}');
                return preferences.enabled === true && preferences.useLocalModel === false;
            },
            { timeoutMsg: 'The protected request preferences were not saved.' }
        );
        await browser.execute(async () =>
            window.__TAURI_INTERNALS__.invoke('plugin:window|hide', { label: 'settings' })
        );
        await waitForE2eBridge();
        await resetSearchSurface();
        await callE2eBridge('sendPrompt', message);
        await waitForTestIdDisplayed('conversation-panel-host');
        await waitForUserMarker();
    });

    after(async () => {
        try {
            await waitForE2eBridge();
            await useInterfaceLanguage('zh-CN');
            await callE2eBridge('clearPrivacyReview');
            await resetSearchSurface();
            if (previousDefaults) await setCardWidth(previousDefaults.width);
            if (providerId)
                await query('UPDATE models SET is_default = 0 WHERE provider_id = ?', [providerId]);
            for (const id of previousDefaultModels)
                await query('UPDATE models SET is_default = 1 WHERE id = ?', [id]);
            if (providerId) await query('DELETE FROM providers WHERE id = ?', [providerId]);
        } finally {
            if (server) await new Promise((resolve) => server.close(resolve));
        }
    });

    it('user hovers the actual masked value then sees short tags the sent placeholder and status in either language at normal and minimum width', async () => {
        const marked = await waitForUserMarker();
        const decoration = await marked.getCSSProperty('text-decoration-style');
        assertVisible(
            decoration.value === 'dashed',
            'The original value is not subtly underlined.'
        );
        assertVisible(
            requestCount === 1,
            'The fixture did not send exactly one real model request.'
        );
        assertVisible(
            (await marked.getText()) === original,
            'The displayed original value changed.'
        );
        const layouts = [];
        for (const [label, width] of [
            ['default', previousDefaults.width],
            ['minimum', 420],
        ]) {
            await setCardWidth(width);
            for (const [locale, method, rule, status, sentLabel] of [
                ['zh-CN', '规则', '邮箱', '已本地脱敏', '实际发送'],
                ['en-US', 'Rules', 'Email', 'Locally protected', 'Actually sent'],
            ]) {
                await useInterfaceLanguage(locale);
                await (await waitForTestIdDisplayed('search-editor-host')).moveTo();
                await marked.moveTo();
                const popup = await waitForTestIdDisplayed('privacy-protection-tooltip');
                const actual = await popup.getText();
                assertVisible(
                    actual.includes(method) && actual.includes(rule),
                    'Actual rule provenance is missing.'
                );
                assertVisible(
                    actual.includes(sentPlaceholder),
                    'The hover differs from the placeholder sent on the wire.'
                );
                assertVisible(actual.includes(status), 'The compact masking status is missing.');
                const sentRow = await popup.$('[data-testid="privacy-protection-placeholder"]');
                assertVisible(
                    (await (await sentRow.parentElement()).getText()).includes(sentLabel),
                    'The placeholder does not identify the actual sent content.'
                );
                const layout = await readTooltipLayout();
                const captureLabel = locale === 'zh-CN' ? label : `${label}-${locale}`;
                layouts.push({ label: captureLabel, locale, ...layout });
                await browser.saveScreenshot(
                    path.join(screenshots, `privacy-hover-${captureLabel}.png`)
                );
                await popup.saveScreenshot(
                    path.join(screenshots, `privacy-hover-${captureLabel}-tooltip.png`)
                );
                await (
                    await browser.$('[data-testid="search-view-card"]')
                ).saveScreenshot(path.join(screenshots, `privacy-hover-${captureLabel}-card.png`));
            }
            await useInterfaceLanguage('zh-CN');
        }
        await fs.writeFile(
            path.join(screenshots, 'layout-evidence.json'),
            JSON.stringify({ requestCount, layouts }, null, 2)
        );
        await setCardWidth(previousDefaults.width);
        for (const layout of layouts) assertTooltipFits(layout);
    });

    it('user receives the restored reply then its underline shows the same sent placeholder in both languages and window widths', async () => {
        const selector = '.assistant-message-parts [data-testid="privacy-protected-text"]';
        const reply = await browser.$(selector);
        await reply.waitForDisplayed();
        assertVisible(
            (await reply.getText()) === original,
            'The assistant original was not restored.'
        );
        const layouts = [];
        for (const [label, width] of [
            ['default', previousDefaults.width],
            ['minimum', 420],
        ]) {
            await setCardWidth(width);
            for (const [locale, status, sentLabel] of [
                ['zh-CN', '已本地还原', '模型返回'],
                ['en-US', 'Locally restored', 'Model returned'],
            ]) {
                await useInterfaceLanguage(locale);
                await (await waitForTestIdDisplayed('search-editor-host')).moveTo();
                await reply.moveTo();
                const popup = await waitForTestIdDisplayed('privacy-protection-tooltip');
                const text = await popup.getText();
                assertVisible(
                    text.includes(status) &&
                        text.includes(sentLabel) &&
                        text.includes(sentPlaceholder),
                    'Reply hover does not match local restoration and the wire placeholder.'
                );
                const layout = await readTooltipLayout(selector);
                assertTooltipFits(layout);
                assertVisible(
                    layout.underline.style === 'dashed',
                    'Reply underline is not subtle and dashed.'
                );
                layouts.push({ label, locale, ...layout });
                await (
                    await browser.$('[data-testid="search-view-card"]')
                ).saveScreenshot(
                    path.join(screenshots, `privacy-reply-${label}-${locale}-card.png`)
                );
            }
            await useInterfaceLanguage('zh-CN');
        }
        await fs.writeFile(
            path.join(screenshots, 'reply-layout-evidence.json'),
            JSON.stringify(layouts, null, 2)
        );
        await setCardWidth(previousDefaults.width);
    });

    it('user focuses and taps the original value then protection stays visible and activating it does not send another request', async () => {
        const marked = await waitForUserMarker();
        await browser.keys('Tab');
        await browser.execute((element) => element.focus(), marked);
        await waitForTestIdDisplayed('privacy-protection-tooltip');
        const focusedLayout = await readTooltipLayout();
        assertMarkerFrameless(focusedLayout);
        assertVisible(
            focusedLayout.marker.focusVisible && focusedLayout.underline.style === 'solid',
            'Keyboard focus does not have a visible underline indicator.'
        );
        await (
            await browser.$('[data-testid="search-view-card"]')
        ).saveScreenshot(path.join(screenshots, 'privacy-hover-keyboard-card.png'));
        await marked.click();
        await browser.keys('Enter');
        const popup = await waitForTestIdDisplayed('privacy-protection-tooltip');
        assertMarkerFrameless(await readTooltipLayout());
        assertVisible(
            (await popup.getText()).includes(sentPlaceholder),
            'Focused activation lost the actual placeholder.'
        );
        assertVisible(requestCount === 1, 'Activating a privacy marker submitted another prompt.');
        await browser.keys('Escape');
        await browser.waitUntil(
            async () =>
                !(await browser.$('[data-testid="privacy-protection-tooltip"]').isExisting())
        );
        await waitForUserMarker();
    });

    it('user focuses controls across native windows and a dropdown then no default black focus outline appears', async () => {
        const surfaces = [{ surface: 'conversation', controls: await readFocusOutlines() }];
        await callE2eBridge('openSettingsWindow');
        await switchToWindowContaining('/settings');
        await (await waitForTestIdDisplayed('settings-nav-privacy-filter')).click();
        await waitForTestIdDisplayed('settings-privacy-filter-section');
        surfaces.push({ surface: 'settings', controls: await readFocusOutlines() });
        const settingsControls = surfaces.at(-1).controls;
        for (const testId of [
            'settings-nav-general',
            'settings-window-minimize',
            'privacy-filter-enabled-toggle',
        ]) {
            assertVisible(
                settingsControls.find((control) => control.testId === testId)?.colorsChanged,
                `Keyboard focus has no visible color feedback on ${testId}.`
            );
        }
        const select = await waitForTestIdDisplayed('privacy-protection-records-range');
        await select.click();
        await (
            await waitForTestIdDisplayed('privacy-protection-records-range-7')
        ).waitForDisplayed();
        const popupId = await select.getAttribute('aria-controls');
        surfaces.push({
            surface: 'dropdown',
            controls: await readFocusOutlines(`[id="${popupId}"]`),
        });
        await browser.keys('Escape');
        await fs.writeFile(
            path.join(screenshots, 'global-focus-evidence.json'),
            JSON.stringify(surfaces, null, 2)
        );
        await browser.execute(async () =>
            window.__TAURI_INTERNALS__.invoke('plugin:window|hide', { label: 'settings' })
        );
        await waitForE2eBridge();
        for (const { surface, controls } of surfaces) {
            assertVisible(controls.length > 0, `No focusable controls were checked in ${surface}.`);
            assertVisible(
                controls.some((control) => control.focusVisible),
                `Keyboard focus was not exercised in ${surface}.`
            );
            assertVisible(
                controls.every((control) => control.outlineStyle !== 'auto'),
                `A default black focus outline remains in ${surface}: ${JSON.stringify(controls)}`
            );
        }
    });

    it('user opens privacy settings after a real request then finds both modes below the chart and the actual replacement in the bottom records', async () => {
        await callE2eBridge('openSettingsWindow');
        await switchToWindowContaining('/settings');
        await (await waitForTestIdDisplayed('settings-nav-privacy-filter')).click();
        await browser.waitUntil(
            async () =>
                (
                    await browser.$$(
                        '[data-testid="privacy-protection-record"][data-direction="restore"]'
                    )
                ).length > 0
        );
        let restoreAction;
        for (const [direction, labels] of [
            ['mask', ['脱敏前', '脱敏后']],
            ['restore', ['还原前', '还原后']],
        ]) {
            const { action, panel, left, right } = await openMatchingRecord(
                direction,
                direction === 'mask' ? original : sentPlaceholder,
                direction === 'mask' ? sentPlaceholder : original
            );
            if (direction === 'restore') restoreAction = action;
            await (await browser.$('[data-testid="settings-nav-privacy-filter"]')).moveTo();
            const restingBackground = await browser.execute(async (element) => {
                await Promise.all(element.getAnimations().map((animation) => animation.finished));
                return getComputedStyle(element).backgroundColor;
            }, action);
            await action.moveTo();
            const hoveredAppearance = await browser.execute(async (element) => {
                await Promise.all(element.getAnimations().map((animation) => animation.finished));
                const style = getComputedStyle(element);
                return { background: style.backgroundColor, shadow: style.boxShadow };
            }, action);
            assertVisible(
                hoveredAppearance.background === restingBackground &&
                    hoveredAppearance.shadow === 'none',
                'Hover adds a separate shaded surface to the record header.'
            );
            const captions = await panel.$$('[data-testid="privacy-protection-stage-label"]');
            const actualLabels = [];
            for (const caption of captions) actualLabels.push(await caption.getText());
            assertVisible(
                JSON.stringify(actualLabels) === JSON.stringify(labels),
                'Record direction captions are incorrect.'
            );
            assertVisible(
                direction === 'mask'
                    ? left.includes(original) && right.includes(sentPlaceholder)
                    : left.includes(sentPlaceholder) && right.includes(original),
                'Before/after frames do not follow the actual replacement direction.'
            );
            await panel.saveScreenshot(path.join(screenshots, `privacy-record-${direction}.png`));
            await action.click();
        }
        assertVisible(Boolean(restoreAction), 'The restored request record is unavailable.');
        const action = restoreAction;
        await action.scrollIntoView();
        await action.click();
        const panel = await waitForTestIdDisplayed('privacy-protection-details');
        assertVisible(
            (await (
                await panel.$('[data-testid="privacy-protection-value-original"]')
            ).getText()) === original,
            'Settings did not retain the actual original value.'
        );
        assertVisible(
            (await (await panel.$('[data-testid="privacy-protection-value-masked"]')).getText()) ===
                sentPlaceholder,
            'Settings replacement differs from the value sent on the wire.'
        );
        const layouts = [];
        for (const [name, width, height] of [
            ['default', 1168, 748],
            ['minimum', 968, 608],
        ]) {
            await browser.setWindowSize(width, height);
            await browser.execute(() => {
                let element = document.querySelector(
                    '[data-testid="settings-privacy-filter-section"]'
                ).parentElement;
                while (element && element !== document.body) {
                    if (element.scrollHeight > element.clientHeight) element.scrollTop = 0;
                    element = element.parentElement;
                }
            });
            await (
                await browser.$('[data-testid="settings-window-shell"]')
            ).saveScreenshot(path.join(screenshots, `privacy-settings-${name}-overview.png`));
            await panel.scrollIntoView();
            const layout = await browser.execute(() => {
                const overview = document.querySelector('section[aria-label="保护概览"]');
                const controls = document.querySelector(
                    '[data-settings-search-target="privacy-filter-mode"]'
                );
                const records = document.querySelector(
                    '[aria-labelledby="privacy-protection-records-title"]'
                );
                const scope = document.querySelector('#privacy-filter-scope-title');
                const details = document.querySelector(
                    '[data-testid="privacy-protection-details"]'
                );
                return {
                    modesBelowChart:
                        overview.getBoundingClientRect().bottom <=
                            controls.getBoundingClientRect().top &&
                        controls.querySelectorAll('[role="radio"]').length === 2,
                    recordsLast: Boolean(
                        scope.compareDocumentPosition(records) & Node.DOCUMENT_POSITION_FOLLOWING
                    ),
                    noOverflow:
                        details.scrollWidth <= details.clientWidth &&
                        document.documentElement.scrollWidth <= innerWidth,
                    contentTopGap:
                        details
                            .querySelector('[data-testid="privacy-protection-stage-label"]')
                            .getBoundingClientRect().top -
                        details
                            .closest('[data-testid="privacy-protection-record"]')
                            .querySelector('[data-testid="privacy-protection-record-open"]')
                            .getBoundingClientRect().bottom,
                    readableLineSpacing: [
                        ...details.querySelectorAll('[data-testid="privacy-protection-stage"] p'),
                    ].every((paragraph) => {
                        const lineHeight = Number.parseFloat(
                            getComputedStyle(paragraph).lineHeight
                        );
                        return [...paragraph.querySelectorAll('span')].every((mark) =>
                            [...mark.getClientRects()].every(
                                (rect) => lineHeight - rect.height >= 3
                            )
                        );
                    }),
                    conversationHintAbsent:
                        !records.textContent.includes('会话中也可悬停下划线文本查看替换情况'),
                    font: getComputedStyle(
                        details.querySelector('[data-testid="privacy-protection-stage"]')
                    ).fontFamily,
                    width: innerWidth,
                    height: innerHeight,
                };
            });
            layouts.push({ name, ...layout });
            assertVisible(
                layout.modesBelowChart && layout.recordsLast && layout.noOverflow,
                'The settings overview and detailed list do not fit in the intended order.'
            );
            assertVisible(
                layout.font.includes('TouchAI Source Han Serif SC'),
                'Replacement values do not use the product serif font.'
            );
            assertVisible(
                layout.readableLineSpacing && layout.conversationHintAbsent,
                'Protected context is cramped or the removed helper sentence remains visible.'
            );
            assertVisible(
                layout.contentTopGap >= 12,
                'Expanded context is too close to the record header.'
            );
            await (
                await browser.$('[data-testid="settings-window-shell"]')
            ).saveScreenshot(path.join(screenshots, `privacy-settings-${name}-details.png`));
        }
        await fs.writeFile(
            path.join(screenshots, 'settings-layout-evidence.json'),
            JSON.stringify(layouts, null, 2)
        );
        await browser.setWindowSize(1168, 748);
        await browser.execute(async () =>
            window.__TAURI_INTERNALS__.invoke('plugin:window|hide', { label: 'settings' })
        );
        await waitForE2eBridge();
    });

    it('user clears protection records in settings then the conversation loses its stale underline and floating private metadata', async () => {
        await waitForE2eBridge();
        await (await waitForTestIdDisplayed('search-editor-host')).moveTo();
        await (await waitForUserMarker()).moveTo();
        await waitForTestIdDisplayed('privacy-protection-tooltip');
        await callE2eBridge('openSettingsWindow');
        await switchToWindowContaining('/settings');
        await browser.execute(async () =>
            window.__TAURI_INTERNALS__.invoke('privacy_filter_clear_records')
        );
        await waitForE2eBridge();
        await browser.waitUntil(
            async () => (await browser.$$('[data-testid="privacy-protected-text"]')).length === 0
        );
        assertVisible(
            !(await browser.$('[data-testid="privacy-protection-tooltip"]').isExisting()),
            'Clearing left private metadata in the DOM.'
        );
        assertVisible(
            (await browser.$('[data-testid="conversation-panel-host"]').getText()).includes(
                original
            ),
            'Clearing review changed the original conversation.'
        );
    });
});

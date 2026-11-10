import {
    assertVisible,
    getAriaChecked,
    switchToWindowContaining,
    switchToWindowWithE2eBridge,
    waitForTestIdDisplayed,
} from './desktop.js';
import { SKILL_FIXTURE_NAME } from './fixtures.js';

async function typeSkillQuery(mainWindowHandle, trigger = '$', query = SKILL_FIXTURE_NAME) {
    await switchToWindowWithE2eBridge(mainWindowHandle);
    const editor = await $("[data-testid='search-editor-host'] .ProseMirror");
    await editor.waitForDisplayed();
    await editor.click();
    await browser.keys(['Control', 'a']);
    await browser.keys(['Backspace']);
    await browser.keys([`${trigger}${query}`]);
    return editor;
}

async function assertSkillUnavailable(mainWindowHandle) {
    const editor = await typeSkillQuery(mainWindowHandle, '/', '');
    const picker = await waitForTestIdDisplayed('skill-picker-panel');
    await browser.waitUntil(
        async () => (await picker.$('[role="listbox"]').getAttribute('aria-busy')) === 'false'
    );
    assertVisible(
        !(await picker.getText()).includes(SKILL_FIXTURE_NAME),
        'The unavailable skill must be absent from the refreshed catalog.'
    );
    await browser.keys([SKILL_FIXTURE_NAME]);
    await browser.waitUntil(async () => (await editor.getAttribute('aria-expanded')) === 'false');
    assertVisible(
        !(await $('[data-testid="skill-picker-panel"]').isExisting()),
        'An unavailable skill must not leave an empty picker visible.'
    );
}

async function closePicker() {
    const editor = await $("[data-testid='search-editor-host'] .ProseMirror");
    await editor.click();
    await browser.keys(['Control', 'a']);
    await browser.keys(['Backspace']);
    await switchToWindowContaining('/settings');
}

export async function selectSkillWithKeyboard(mainWindowHandle, trigger = '$') {
    try {
        const query = SKILL_FIXTURE_NAME.slice(0, -3);
        const editor = await typeSkillQuery(mainWindowHandle, trigger, query);
        const completion = await $('[data-inline-completion]');
        await completion.waitForExist();
        await browser.waitUntil(
            async () =>
                (await completion.getAttribute('data-inline-completion')) ===
                SKILL_FIXTURE_NAME.slice(query.length)
        );
        assertVisible(
            (await editor.getAttribute('aria-expanded')) === 'true' &&
                (await $$('[data-testid="skill-picker-panel"] [role="option"]')).length === 1,
            'A unique name prefix must keep its one-row list alongside inline completion.'
        );
        await browser.keys([trigger === '/' ? 'Enter' : 'Tab']);
        const tag = await $(`[data-skill-name="${SKILL_FIXTURE_NAME}"]`);
        await tag.waitForDisplayed();
        await completion.waitForExist({ reverse: true });
        const appearance = await browser.execute((name) => {
            const element = document.querySelector(`[data-skill-name="${name}"]`);
            const style = getComputedStyle(element);
            const editor = document.querySelector('.ProseMirror');
            const tagBounds = element.getBoundingClientRect();
            const editorBounds = editor.getBoundingClientRect();
            return {
                background: style.backgroundColor,
                border: style.borderTopWidth,
                name: element.textContent.trim(),
                removeControls: element.querySelectorAll('button').length,
                fitsInput:
                    tagBounds.left >= editorBounds.left && tagBounds.right <= editorBounds.right,
                editorFocused: document.activeElement === editor,
            };
        }, SKILL_FIXTURE_NAME);
        assertVisible(
            appearance.background === 'rgba(0, 0, 0, 0)' && appearance.border === '0px',
            `The selected skill should be an inline label: ${JSON.stringify(appearance)}`
        );
        assertVisible(
            appearance.name === SKILL_FIXTURE_NAME &&
                appearance.removeControls === 0 &&
                appearance.fitsInput &&
                appearance.editorFocused,
            `The skill should remain an inline reference with editor focus: ${JSON.stringify(appearance)}`
        );
    } finally {
        await closePicker();
    }
}

export async function manageSkillAcrossWindows(mainWindowHandle) {
    await (await waitForTestIdDisplayed('settings-nav-skills')).click();
    const panel = await waitForTestIdDisplayed('settings-skills');
    await waitForTestIdDisplayed('settings-skills-list');
    assertVisible(
        (await panel.getText()).includes(SKILL_FIXTURE_NAME),
        'The skill was not listed.'
    );
    for (const [width, height] of [
        [920, 560],
        [1120, 700],
    ]) {
        await browser.setWindowSize(width, height);
        await browser.waitUntil(
            async () =>
                browser.execute(() => {
                    const panel = document.querySelector('[data-testid="settings-skills"]');
                    return panel && panel.scrollWidth <= panel.clientWidth;
                }),
            { timeoutMsg: `The skills layout overflows at ${width}px.` }
        );
    }
    const content = await panel.$('pre');
    await content.waitForDisplayed();
    assertVisible(
        (await content.getText()).includes('Write exactly three bullet points.'),
        'Settings did not read the installed SKILL.md.'
    );

    let toggle = await waitForTestIdDisplayed('settings-skills-toggle-disabled');
    await toggle.click();
    await browser.waitUntil(async () => (await getAriaChecked(toggle)) === 'false');
    await panel.$('[aria-label="Refresh skills"]').click();
    await waitForTestIdDisplayed('settings-skills-list');
    toggle = await waitForTestIdDisplayed('settings-skills-toggle-disabled');
    await browser.waitUntil(
        async () => (await toggle.isEnabled()) && (await getAriaChecked(toggle)) === 'false'
    );
    try {
        await assertSkillUnavailable(mainWindowHandle);
    } finally {
        await closePicker();
    }

    await toggle.click();
    await browser.waitUntil(async () => (await getAriaChecked(toggle)) === 'true');
    await selectSkillWithKeyboard(mainWindowHandle);
    await (await waitForTestIdDisplayed('settings-skills-delete')).click();
    const dialog = await $('[role="alertdialog"], [role="dialog"]');
    await dialog.waitForDisplayed();
    assertVisible(
        (await dialog.getText()).includes(`Delete ${SKILL_FIXTURE_NAME}?`),
        'Deletion targeted a different skill.'
    );
    await dialog.$('button=Delete skill').click();
    await browser.waitUntil(async () => !(await panel.getText()).includes(SKILL_FIXTURE_NAME));
    try {
        await assertSkillUnavailable(mainWindowHandle);
    } finally {
        await closePicker();
    }
}

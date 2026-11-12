import {
    assertVisible,
    callE2eBridge,
    resetSearchSurface,
    waitForE2eBridge,
    waitForTestIdDisplayed,
} from '../support/desktop.js';
import {
    assertContentSizedResultPanel,
    measureCompactSkillRows,
    measureResultPanel,
    recordResultPanelExpansion,
} from '../support/result-panel.js';

const QUERY = 'zz-file-reference-fixture';
const FILES = Array.from({ length: 36 }, (_, index) => ({
    name: `Document ${index + 1}.md`,
    path: `C:/TouchAI/file-reference-fixture/Document-${index + 1}.md`,
    source: 'file',
}));

async function typeReferenceQuery(count = FILES.length) {
    const editor = await $('.ProseMirror');
    await editor.click();
    await browser.keys([`Please read @${QUERY}`]);
    await waitForTestIdDisplayed('quick-search-panel');
    await browser.waitUntil(
        async () =>
            (await $$('[data-testid="quick-search-panel"] [role="option"]')).length === count,
        { timeoutMsg: 'The @ filename query did not find its fixture files.' }
    );
}

describe('given @ file references use the existing result panel', () => {
    before(async () => {
        await waitForE2eBridge();
    });
    beforeEach(async () => {
        await resetSearchSurface();
        await callE2eBridge('setSearchFixture', QUERY, FILES);
    });
    afterEach(resetSearchSurface);

    it('user given several batches of files when scrolling below the first batch then expands before continuing to scroll', async () => {
        await typeReferenceQuery();
        const panel = await waitForTestIdDisplayed('quick-search-panel');
        if (!(await panel.$('.quick-search-grid').isExisting())) {
            await panel.$('[data-testid="quick-search-view-toggle"]').click();
        }
        const initial = await browser.execute(measureResultPanel, 'quick-search-panel');
        const frames = await browser.execute(recordResultPanelExpansion);
        assertVisible(
            frames.every(
                ({ card, input, footer }) =>
                    input.top >= card.top - 1 &&
                    input.bottom <= card.bottom + 1 &&
                    footer.top >= card.top - 1 &&
                    footer.bottom <= card.bottom + 1
            ),
            'The input and shortcut footer must remain inside the card throughout expansion.'
        );
        await browser.waitUntil(
            async () =>
                (await browser.execute(measureResultPanel, 'quick-search-panel')).viewportHeight >
                initial.viewportHeight
        );
        const expanded = await browser.execute(measureResultPanel, 'quick-search-panel');
        await browser.waitUntil(
            () =>
                browser.execute(() => {
                    const viewport = document.querySelector('[data-slot="result-panel-viewport"]');
                    const bounds = viewport.getBoundingClientRect();
                    return [...viewport.querySelectorAll('[data-slot="result-item"]')]
                        .filter((row) => {
                            const rect = row.getBoundingClientRect();
                            return rect.top < bounds.bottom && rect.bottom > bounds.top;
                        })
                        .every((row) => {
                            const icon = row.querySelector('img');
                            return icon?.complete && icon.naturalWidth > 0;
                        });
                }),
            { timeoutMsg: 'Newly revealed file icons must load without another scroll.' }
        );
        await browser.execute(() => {
            document
                .querySelector('[data-slot="result-panel-viewport"]')
                .dispatchEvent(
                    new WheelEvent('wheel', { deltaY: 120, bubbles: true, cancelable: true })
                );
        });
        assertVisible(
            (await browser.execute(measureResultPanel, 'quick-search-panel')).viewportHeight ===
                expanded.viewportHeight,
            'Further scrolling must not grow a third stage.'
        );
    });

    it('user given an expanded idle picker when referencing a file and continuing prose then keeps it closed until another @ query', async () => {
        await typeReferenceQuery();
        await browser.execute(recordResultPanelExpansion);
        await callE2eBridge('setSearchFixture', 'Please read  continue', FILES.slice(0, 1));
        await browser.keys(['ArrowDown']);
        await browser.keys(['Tab']);
        await browser.waitUntil(() => $('[data-attachment-tag]').isExisting());
        await browser.keys(['continue']);
        await browser.waitUntil(
            async () => !(await $('[data-testid="quick-search-panel"]').isDisplayed()),
            {
                timeoutMsg:
                    'Finishing a reference must stop queries while its old panel folds away.',
            }
        );
        assertVisible(
            (await $('.ProseMirror').getAttribute('aria-expanded')) === 'false',
            'Continuing prose must not restore the completed reference picker.'
        );
        await callE2eBridge('setSearchFixture', QUERY, FILES);
        await browser.keys([` @${QUERY}`]);
        await waitForTestIdDisplayed('quick-search-panel');
    });

    it('user given one matching file when opening either layout then sees only one row of results', async () => {
        await callE2eBridge('setSearchFixture', QUERY, FILES.slice(0, 1));
        await typeReferenceQuery(1);
        for (const layout of ['grid', 'list']) {
            const panel = await waitForTestIdDisplayed('quick-search-panel');
            if ((await panel.$('.quick-search-grid').isExisting()) !== (layout === 'grid')) {
                await panel.$('[data-testid="quick-search-view-toggle"]').click();
            }
            await browser.waitUntil(async () =>
                browser.execute(
                    () =>
                        document.querySelector('[data-testid="search-view-card"]').getAnimations()
                            .length === 0
                )
            );
            assertContentSizedResultPanel(
                await browser.execute(measureResultPanel, 'quick-search-panel')
            );
        }
    });

    it('user given one matching skill name when confirming it then keeps its list and inline suffix until insertion', async () => {
        await (await $('.ProseMirror')).click();
        await browser.keys(['/skill-creat']);
        await browser.waitUntil(
            async () =>
                (await $('.ProseMirror').getAttribute('aria-expanded')) === 'true' &&
                (await $$('[data-testid="skill-picker-panel"] [role="option"]')).length === 1 &&
                (await $('[data-inline-completion]').getAttribute('data-inline-completion')) ===
                    'or'
        );
        await browser.keys(['Enter']);
        await browser.waitUntil(() => $('[data-skill-name="skill-creator"]').isExisting());
    });

    it('user given a short conversation when opening skills then sees complete alphabetical rows and can select the first one', async () => {
        await callE2eBridge('setConversation', [
            {
                id: 'short-user',
                role: 'user',
                content: 'Review the draft.',
                parts: [],
                timestamp: 1,
            },
            {
                id: 'short-answer',
                role: 'assistant',
                content: 'Select the skill to continue.',
                parts: [],
                timestamp: 2,
            },
        ]);
        await (await $('.ProseMirror')).click();
        await browser.keys(['/']);
        await waitForTestIdDisplayed('skill-picker-panel');
        const opened = await browser.execute(measureCompactSkillRows);
        assertVisible(opened.iconCount === 0, 'Compact skill choices must have no leading icons.');
        assertVisible(opened.partialRows === 0, 'A compact picker must end after a complete row.');
        assertVisible(opened.visibleRows <= 9, 'A compact picker must show at most nine rows.');
        assertVisible(
            opened.badgeOffsets.every((offset) => Math.abs(offset) < 0.6),
            'Source badges must be vertically centered with their row.'
        );
        assertVisible(
            JSON.stringify(opened.names) ===
                JSON.stringify([...opened.names].sort((left, right) => left.localeCompare(right))),
            'All skill sources must participate in one alphabetical sequence.'
        );
        await browser.execute(() => {
            document
                .querySelector('[data-testid="skill-picker-panel"] [role="listbox"]')
                .dispatchEvent(
                    new WheelEvent('wheel', { deltaY: 120, bubbles: true, cancelable: true })
                );
        });
        assertVisible(
            Math.abs((await browser.execute(measureCompactSkillRows)).height - opened.height) < 1,
            'A compact picker must not grow a second stage when scrolling.'
        );
        await browser.waitUntil(
            () =>
                browser.execute(() => {
                    const row = document.querySelector(
                        '[data-testid="skill-picker-panel"] [role="option"]'
                    );
                    const rect = row.getBoundingClientRect();
                    return row.contains(
                        document.elementFromPoint(rect.x + rect.width / 2, rect.y + rect.height / 2)
                    );
                }),
            { timeoutMsg: 'The conversation toolbar must not cover a floating result.' }
        );
        await (await $$('[data-testid="skill-picker-panel"] [role="option"]'))[0].click();
        await browser.waitUntil(() => $('[data-skill-tag]').isExisting());
    });

    it('user given unmatched reference text when searching then sees no panel and recovers when matches return', async () => {
        const editor = await $('.ProseMirror');
        await editor.click();
        await callE2eBridge('setSearchFixture', 'zz-empty-reference-fixture', []);
        await browser.keys(['Please read @zz-empty-reference-fixture']);
        await browser.waitUntil(
            async () => !(await $('[data-testid="quick-search-panel"]').isDisplayed())
        );
        assertVisible(
            (await editor.getAttribute('aria-expanded')) === 'false',
            'An empty reference result must not expose an expanded picker.'
        );
        await browser.keys(['Control', 'a']);
        await browser.keys(['NULL']);
        await browser.keys(['Backspace']);
        await callE2eBridge('setSearchFixture', QUERY, FILES);
        await typeReferenceQuery();
    });

    it('user given a conversation when typing @ then sees compact results floating above the editor without moving the conversation', async () => {
        await callE2eBridge('setConversation', [
            {
                id: 'prior',
                role: 'user',
                content: 'Existing conversation\n\n'.repeat(30),
                parts: [],
                timestamp: 1,
            },
        ]);
        await browser.waitUntil(() =>
            browser.execute(() => {
                const card = document.querySelector('[data-testid="search-view-card"]');
                return card.getBoundingClientRect().height > 500 && !card.getAnimations().length;
            })
        );
        const before = await browser.execute(() => {
            const r = document
                .querySelector('[data-testid="conversation-panel-host"]')
                .getBoundingClientRect();
            return { top: r.top, height: r.height };
        });
        await typeReferenceQuery();
        await browser.waitUntil(
            () =>
                browser.execute(() => {
                    const editor = document.querySelector('[data-testid="search-editor-host"]');
                    const panel = document.querySelector('[data-testid="quick-search-panel"]');
                    const card = document.querySelector('[data-testid="search-view-card"]');
                    return (
                        panel.getBoundingClientRect().bottom <=
                            editor.getBoundingClientRect().top &&
                        panel.getBoundingClientRect().bottom <=
                            card.getBoundingClientRect().bottom + 1
                    );
                }),
            {
                timeoutMsg:
                    'The @ picker must float above the editor inside the conversation card.',
            }
        );
        const after = await browser.execute(() => {
            const conversation = document
                .querySelector('[data-testid="conversation-panel-host"]')
                .getBoundingClientRect();
            const rows = [
                ...document.querySelectorAll('[data-testid="quick-search-panel"] [role="option"]'),
            ];
            const panel = document.querySelector('[data-testid="quick-search-panel"]');
            const panelBounds = panel.getBoundingClientRect();
            const panelStyle = getComputedStyle(panel);
            const input = document
                .querySelector('[data-testid="search-bar"]')
                .getBoundingClientRect();
            return {
                top: conversation.top,
                height: conversation.height,
                bottomGap: input.top - panelBounds.bottom,
                leftInset: panelBounds.left - input.left,
                rightInset: input.right - panelBounds.right,
                widthRatio: panelBounds.width / input.width,
                heightRatio:
                    panelBounds.height /
                    document
                        .querySelector('[data-testid="search-view-card"]')
                        .getBoundingClientRect().height,
                backdropFilter: panelStyle.backdropFilter,
                bottomLeftRadius: panelStyle.borderBottomLeftRadius,
                bottomRightRadius: panelStyle.borderBottomRightRadius,
                bottomBorder: panelStyle.borderBottomWidth,
                shadow: panelStyle.boxShadow,
                hasFooter: !!panel.querySelector('[data-slot="result-panel-footer"]'),
                compact: rows.every((row) => {
                    const icon = row
                        .querySelector('[data-slot="result-item-icon"]')
                        .getBoundingClientRect();
                    const label = row
                        .querySelector('[data-slot="result-item-label"]')
                        .getBoundingClientRect();
                    const description = row
                        .querySelector('[data-slot="result-item-description"]')
                        .getBoundingClientRect();
                    return (
                        row.getBoundingClientRect().height <= 32 &&
                        Math.abs(icon.top + icon.height / 2 - label.top - label.height / 2) < 1 &&
                        Math.abs(
                            label.top + label.height / 2 - description.top - description.height / 2
                        ) < 1 &&
                        Math.abs(description.left - label.right - 8) < 1
                    );
                }),
            };
        });
        assertVisible(
            Math.abs(before.top - after.top) < 1 && Math.abs(before.height - after.height) < 1,
            'Opening a floating picker must not move or shrink the conversation.'
        );
        assertVisible(after.compact, 'Each file must use one compact, horizontally aligned row.');
        assertVisible(
            Math.abs(after.bottomGap) < 1 &&
                Math.abs(after.widthRatio - 0.8) < 0.005 &&
                Math.abs(after.leftInset - after.rightInset) < 1,
            'The floating picker must meet the input directly and use 80% of its width, centered.'
        );
        assertVisible(
            after.heightRatio <= 0.8 && after.backdropFilter.startsWith('blur('),
            'The picker must occupy at most 80% of the card height and blur the conversation behind it.'
        );
        assertVisible(!after.hasFooter, 'The floating picker must not include a shortcut footer.');
        assertVisible(
            after.bottomLeftRadius === '0px' &&
                after.bottomRightRadius === '0px' &&
                after.bottomBorder === '0px' &&
                after.shadow === 'none',
            'The picker must join the input with a straight bottom edge and no separating shadow.'
        );
        assertVisible(
            (await (
                await $$('[data-testid="quick-search-panel"] [role="option"]')
            )[0].getAttribute('aria-selected')) === 'true',
            'A conversation picker must select its first candidate while the editor keeps focus.'
        );
        await browser.keys(['Tab']);
        await browser.waitUntil(() => $('[data-attachment-tag]').isExisting());
        const result = await browser.execute(() => {
            const editor = document.querySelector('.ProseMirror');
            const draft = editor.cloneNode(true);
            draft.querySelectorAll('[data-search-tag]').forEach((tag) => tag.remove());
            return {
                text: draft.textContent,
                file: editor.querySelector('[data-attachment-tag]').textContent.trim(),
                focused: document.activeElement === editor,
            };
        });
        assertVisible(
            result.text === 'Please read  ',
            'Reference insertion must preserve the prose and append one separator.'
        );
        assertVisible(result.file === FILES[0].name, 'Tab must reference the selected file.');
        assertVisible(result.focused, 'Reference insertion must keep the editor focused.');
        await browser.keys(['explain']);
        await browser.waitUntil(
            async () => !(await $('[data-testid="quick-search-panel"]').isDisplayed()),
            { timeoutMsg: 'Typing after a reference must not reopen file search without a new @.' }
        );
        await browser.keys([` @${QUERY}`]);
        await waitForTestIdDisplayed('quick-search-panel');
    });

    it('user given a constrained result viewport when navigating either layout then sees the active file', async () => {
        await typeReferenceQuery();
        for (const layout of ['grid', 'list']) {
            const panel = await waitForTestIdDisplayed('quick-search-panel');
            if ((await panel.$('.quick-search-grid').isExisting()) !== (layout === 'grid')) {
                await panel.$('[data-testid="quick-search-view-toggle"]').click();
            }
            for (let index = 0; index < 8; index += 1) {
                await browser.keys(['ArrowDown']);
                await browser.waitUntil(
                    () =>
                        browser.execute(() => {
                            const editor = document.querySelector('.ProseMirror');
                            const row = document.getElementById(
                                editor.getAttribute('aria-activedescendant')
                            );
                            const viewport = document.querySelector(
                                '[data-testid="quick-search-panel"] [role="listbox"]'
                            );
                            if (!row || !viewport) return false;
                            const item = row.getBoundingClientRect();
                            const bounds = viewport.getBoundingClientRect();
                            return (
                                item.top >= bounds.top - 1 &&
                                item.bottom <= bounds.bottom + 1 &&
                                document.activeElement === editor
                            );
                        }),
                    {
                        timeoutMsg: `The active ${layout} file must remain visible without moving editor focus.`,
                    }
                );
            }
        }
    });
});

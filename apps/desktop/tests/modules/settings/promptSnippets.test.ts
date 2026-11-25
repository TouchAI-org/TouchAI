import { createSettingsPanelFixture } from '@tests/utils/settingsPanel';
import { afterEach, describe, expect, it } from 'vitest';

import type { PromptSnippet } from '@/app/api/settings/preferences';
import {
    addPromptSnippet,
    applyPersistedGeneralSettingValue,
    createDefaultGeneralSettings,
    createEmptyPromptSnippetStorage,
    markPromptSnippetUsed,
    parsePersistedPromptSnippets,
    PromptSnippetValidationError,
    removePromptSnippet,
    serializeGeneralSetting,
    sortPromptSnippets,
    updatePromptSnippet,
} from '@/app/api/settings/preferences';

const NOW = '2026-11-22T01:00:00.000Z';
const LATER = '2026-11-22T02:00:00.000Z';

function snippet(overrides: Partial<ReturnType<typeof createSnippet>> = {}) {
    return {
        ...createSnippet(),
        ...overrides,
    };
}

function createSnippet(): PromptSnippet {
    return {
        id: 'snippet-a',
        title: 'Summarize',
        body: 'Summarize the current draft.',
        isFavorite: false,
        sortOrder: 10,
        lastUsedAt: null,
        createdAt: NOW,
        updatedAt: NOW,
    };
}

let fixture: Awaited<ReturnType<typeof createSettingsPanelFixture>> | undefined;

afterEach(async () => {
    await fixture?.dispose();
    fixture = undefined;
});

describe('given prompt snippets use the approved settings storage contract', () => {
    it('user first opens General Settings and sees paste-only with no snippets', () => {
        const settings = createDefaultGeneralSettings();

        expect(settings.promptSnippetInsertionMode).toBe('paste_only');
        expect(settings.promptSnippets.items).toEqual([]);
        expect(settings.promptSnippets.storageIssue).toBeNull();
    });

    it('user saves snippets and sees the versioned approved JSON round-trip', () => {
        const items = [
            snippet({
                id: 'snippet-b',
                title: 'Review',
                body: 'Review this change.',
                isFavorite: true,
                sortOrder: 1,
            }),
            snippet(),
        ];
        const raw = JSON.stringify({ schemaVersion: 1, items });
        const settings = createDefaultGeneralSettings();

        applyPersistedGeneralSettingValue(settings, 'prompt_snippets_v1', raw);

        expect(settings.promptSnippets.items.map(({ id }) => id)).toEqual([
            'snippet-b',
            'snippet-a',
        ]);
        expect(JSON.parse(serializeGeneralSetting(settings, 'prompt_snippets_v1'))).toEqual({
            schemaVersion: 1,
            items: [items[0], items[1]],
        });
    });

    it('user reopens favorites first and sees a stable order even after using an item', () => {
        const items = [
            snippet({ id: 'recent', sortOrder: 0, lastUsedAt: LATER }),
            snippet({ id: 'normal', sortOrder: 1, lastUsedAt: NOW }),
            snippet({ id: 'favorite-b', isFavorite: true, sortOrder: 2 }),
            snippet({ id: 'favorite-a', isFavorite: true, sortOrder: 1 }),
        ];

        const sorted = sortPromptSnippets(items);
        const used = markPromptSnippetUsed(
            createEmptyPromptSnippetStorage(items),
            'normal',
            '2026-11-22T03:00:00.000Z'
        );

        expect(sorted.map(({ id }) => id)).toEqual([
            'favorite-a',
            'favorite-b',
            'recent',
            'normal',
        ]);
        expect(sortPromptSnippets(used.items).map(({ id }) => id)).toEqual(
            sorted.map(({ id }) => id)
        );
    });

    it('user reopens malformed storage and sees an error instead of snippets', () => {
        const parsed = parsePersistedPromptSnippets('{not-json');

        expect(parsed.items).toEqual([]);
        expect(parsed.storageIssue).toBe('invalid_json');
    });

    it('user reopens storage written by a future version and sees an unsupported-version error', () => {
        const parsed = parsePersistedPromptSnippets(
            JSON.stringify({ schemaVersion: 2, items: [{ future: 'shape' }] })
        );

        expect(parsed.items).toEqual([]);
        expect(parsed.storageIssue).toBe('unsupported_version');
    });

    it.each([
        ['a primitive', 'null'],
        ['an array', '[]'],
    ])('user reopens storage with %s root and sees an invalid-json error', (_shape, raw) => {
        const parsed = parsePersistedPromptSnippets(raw);

        expect(parsed.items).toEqual([]);
        expect(parsed.storageIssue).toBe('invalid_json');
    });

    it.each([
        [
            'future-version',
            JSON.stringify({
                schemaVersion: 2,
                items: [{ futureField: 'must survive' }],
                futureMetadata: true,
            }),
            'unsupported_version',
        ],
        ['malformed-json', '{not-json', 'invalid_json'],
        ['non-object-root', '[]', 'invalid_json'],
    ] as const)(
        'user attempts to overwrite %s storage and sees the original value preserved',
        async (_kind, raw, expectedIssue) => {
            fixture = await createSettingsPanelFixture({
                values: { prompt_snippets_v1: raw },
            });

            const result = await fixture.window.settings.mutate(
                'prompt_snippets_v1',
                createEmptyPromptSnippetStorage([snippet()])
            );

            expect(result.status).toBe('rejected');
            expect(fixture.saved('prompt_snippets_v1')).toBe(raw);
            expect(fixture.client.settings.getSnapshot().promptSnippets.storageIssue).toBe(
                expectedIssue
            );
        },
        15_000
    );

    it('user reopens storage with one malformed item and keeps only valid snippets visible', () => {
        const parsed = parsePersistedPromptSnippets(
            JSON.stringify({
                schemaVersion: 1,
                items: [snippet(), { ...snippet({ id: 'invalid' }), title: '' }],
            })
        );

        expect(parsed.items.map(({ id }) => id)).toEqual(['snippet-a']);
        expect(parsed.storageIssue).toBe('invalid_items');
    });

    it('user creates edits and deletes snippets through the storage adapter', () => {
        const created = addPromptSnippet(
            createEmptyPromptSnippetStorage(),
            {
                title: '  Operator  ',
                body: 'Write a concise update.',
                isFavorite: false,
            },
            { id: 'created', now: NOW }
        );
        const edited = updatePromptSnippet(
            created,
            'created',
            {
                title: 'Operator update',
                body: 'Write a concise operator update.',
                isFavorite: true,
                sortOrder: 3,
            },
            LATER
        );
        const removed = removePromptSnippet(edited, 'created');

        expect(created.items[0]).toMatchObject({
            id: 'created',
            title: 'Operator',
            sortOrder: 0,
            createdAt: NOW,
        });
        expect(edited.items[0]).toMatchObject({
            id: 'created',
            title: 'Operator update',
            body: 'Write a concise operator update.',
            isFavorite: true,
            sortOrder: 3,
            createdAt: NOW,
            updatedAt: LATER,
        });
        expect(removed.items).toEqual([]);
    });

    it('user exceeds a snippet limit and sees a validation error without truncation', () => {
        let storage = createEmptyPromptSnippetStorage();
        for (let index = 0; index < 20; index += 1) {
            storage = addPromptSnippet(
                storage,
                {
                    title: `Snippet ${index}`,
                    body: `Body ${index}`,
                    isFavorite: false,
                },
                { id: `snippet-${index}`, now: NOW }
            );
        }

        expect(() =>
            addPromptSnippet(
                storage,
                { title: 'Overflow', body: 'Overflow body', isFavorite: false },
                { id: 'overflow', now: NOW }
            )
        ).toThrow(PromptSnippetValidationError);
        expect(() =>
            updatePromptSnippet(
                storage,
                'snippet-0',
                { title: 'x'.repeat(81), body: 'Body', isFavorite: false },
                NOW
            )
        ).toThrow(expect.objectContaining({ code: 'title_too_long' }));
        expect(() =>
            updatePromptSnippet(
                storage,
                'snippet-0',
                { title: 'Title', body: 'x'.repeat(10_001), isFavorite: false },
                NOW
            )
        ).toThrow(expect.objectContaining({ code: 'body_too_long' }));
    });

    it('user attempts to save a twenty-first snippet through the settings updater and sees it rejected', async () => {
        fixture = await createSettingsPanelFixture();
        const items = Array.from({ length: 21 }, (_, index) =>
            snippet({
                id: `snippet-${index}`,
                title: `Snippet ${index}`,
                body: `Body ${index}`,
                sortOrder: index,
            })
        );
        const savedBefore = fixture.saved('prompt_snippets_v1');

        expect(() =>
            fixture?.preferences.updatePromptSnippets({
                schemaVersion: 1,
                items,
            })
        ).toThrow('too_many_items');

        expect(fixture.saved('prompt_snippets_v1')).toBe(savedBefore);
        expect(fixture.window.settings.getSnapshot().promptSnippets.items).toEqual([]);
    });

    it('user changes insertion mode and another window sees the committed preference', async () => {
        fixture = await createSettingsPanelFixture();

        await fixture.preferences.updatePromptSnippetInsertionMode('paste_and_send');

        expect(fixture.saved('prompt_snippet_insertion_mode')).toBe('paste_and_send');
        expect(fixture.window.settings.getSnapshot().promptSnippetInsertionMode).toBe(
            'paste_and_send'
        );
        expect(fixture.client.settings.getSnapshot().promptSnippetInsertionMode).toBe(
            'paste_and_send'
        );
    });

    it('user saves snippets and another window receives the committed collection', async () => {
        fixture = await createSettingsPanelFixture();
        const collection = createEmptyPromptSnippetStorage([snippet()]);

        await fixture.preferences.updatePromptSnippets(collection);

        expect(JSON.parse(fixture.saved('prompt_snippets_v1') ?? '{}')).toEqual(collection);
        expect(
            fixture.window.settings.getSnapshot().promptSnippets.items.map(({ id }) => id)
        ).toEqual(['snippet-a']);
        expect(
            fixture.client.settings.getSnapshot().promptSnippets.items.map(({ id }) => id)
        ).toEqual(['snippet-a']);
    });
});

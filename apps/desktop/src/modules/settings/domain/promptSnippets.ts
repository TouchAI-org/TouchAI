import { z } from '@/utils/zod';

export const PROMPT_SNIPPET_SETTING_KEY = 'prompt_snippets_v1';
export const PROMPT_SNIPPET_INSERTION_MODE_SETTING_KEY = 'prompt_snippet_insertion_mode';
export const PROMPT_SNIPPET_SCHEMA_VERSION = 1;
export const PROMPT_SNIPPET_MAX_ITEMS = 20;
export const PROMPT_SNIPPET_TITLE_MAX_LENGTH = 80;
export const PROMPT_SNIPPET_BODY_MAX_LENGTH = 10_000;

export type PromptSnippetInsertionMode = 'paste_only' | 'paste_and_send';
export type PromptSnippetStorageIssue = 'invalid_json' | 'invalid_items' | 'too_many_items' | null;
export type PromptSnippetValidationCode =
    | 'too_many_items'
    | 'not_found'
    | 'empty_title'
    | 'title_too_long'
    | 'empty_body'
    | 'body_too_long';

export interface PromptSnippet {
    id: string;
    title: string;
    body: string;
    isFavorite: boolean;
    sortOrder: number;
    lastUsedAt: string | null;
    createdAt: string;
    updatedAt: string;
}

export interface PromptSnippetStorage {
    schemaVersion: typeof PROMPT_SNIPPET_SCHEMA_VERSION;
    items: PromptSnippet[];
}

/** Runtime projection. `storageIssue` is derived from persisted JSON and is never serialized. */
export interface PromptSnippetSettings extends PromptSnippetStorage {
    storageIssue: PromptSnippetStorageIssue;
}

export interface PromptSnippetDraft {
    title: string;
    body: string;
    isFavorite: boolean;
    sortOrder?: number;
}

export class PromptSnippetValidationError extends Error {
    constructor(readonly code: PromptSnippetValidationCode) {
        super(code);
        this.name = 'PromptSnippetValidationError';
    }
}

const timestampSchema = z
    .string()
    .refine((value) => !Number.isNaN(Date.parse(value)), { message: 'invalid timestamp' });

const promptSnippetItemSchema = z
    .object({
        id: z.string().min(1),
        title: z
            .string()
            .refine((value) => value.trim().length > 0, { message: 'title is empty' })
            .refine((value) => value.length <= PROMPT_SNIPPET_TITLE_MAX_LENGTH, {
                message: 'title is too long',
            }),
        body: z
            .string()
            .refine((value) => value.trim().length > 0, { message: 'body is empty' })
            .refine((value) => value.length <= PROMPT_SNIPPET_BODY_MAX_LENGTH, {
                message: 'body is too long',
            }),
        isFavorite: z.boolean(),
        sortOrder: z.number().int().nonnegative(),
        lastUsedAt: timestampSchema.nullable(),
        createdAt: timestampSchema,
        updatedAt: timestampSchema,
    })
    .strict();

export function createEmptyPromptSnippetSettings(): PromptSnippetSettings {
    return {
        schemaVersion: PROMPT_SNIPPET_SCHEMA_VERSION,
        items: [],
        storageIssue: null,
    };
}

export function normalizePromptSnippetInsertionMode(value: unknown): PromptSnippetInsertionMode {
    return value === 'paste_and_send' ? 'paste_and_send' : 'paste_only';
}

export function createEmptyPromptSnippetStorage(items: PromptSnippet[] = []): PromptSnippetStorage {
    return {
        schemaVersion: PROMPT_SNIPPET_SCHEMA_VERSION,
        items: sortPromptSnippets(items).map(clonePromptSnippet),
    };
}

export function parsePersistedPromptSnippets(raw: string | null): PromptSnippetSettings {
    if (!raw) {
        return createEmptyPromptSnippetSettings();
    }

    let value: unknown;
    try {
        value = JSON.parse(raw);
    } catch {
        return { ...createEmptyPromptSnippetSettings(), storageIssue: 'invalid_json' };
    }

    if (
        !value ||
        typeof value !== 'object' ||
        Array.isArray(value) ||
        !Object.prototype.hasOwnProperty.call(value, 'schemaVersion') ||
        !Object.prototype.hasOwnProperty.call(value, 'items')
    ) {
        return { ...createEmptyPromptSnippetSettings(), storageIssue: 'invalid_json' };
    }

    const candidate = value as Record<string, unknown>;
    if (
        candidate.schemaVersion !== PROMPT_SNIPPET_SCHEMA_VERSION ||
        !Array.isArray(candidate.items)
    ) {
        return { ...createEmptyPromptSnippetSettings(), storageIssue: 'invalid_json' };
    }

    const items: PromptSnippet[] = [];
    const ids = new Set<string>();
    let hadInvalidItem = false;
    for (const item of candidate.items) {
        const parsed = promptSnippetItemSchema.safeParse(item);
        if (!parsed.success || ids.has(parsed.data.id)) {
            hadInvalidItem = true;
            continue;
        }
        ids.add(parsed.data.id);
        items.push(parsed.data);
    }

    const sorted = sortPromptSnippets(items);
    const overflowed = sorted.length > PROMPT_SNIPPET_MAX_ITEMS;
    return {
        schemaVersion: PROMPT_SNIPPET_SCHEMA_VERSION,
        items: sorted.slice(0, PROMPT_SNIPPET_MAX_ITEMS).map(clonePromptSnippet),
        storageIssue: overflowed ? 'too_many_items' : hadInvalidItem ? 'invalid_items' : null,
    };
}

export function sortPromptSnippets(items: readonly PromptSnippet[]): PromptSnippet[] {
    return [...items].sort(
        (left, right) =>
            Number(right.isFavorite) - Number(left.isFavorite) ||
            left.sortOrder - right.sortOrder ||
            left.id.localeCompare(right.id)
    );
}

export function addPromptSnippet(
    storage: PromptSnippetStorage,
    draft: PromptSnippetDraft,
    options: { id: string; now: string }
): PromptSnippetStorage {
    if (storage.items.length >= PROMPT_SNIPPET_MAX_ITEMS) {
        throw new PromptSnippetValidationError('too_many_items');
    }
    const normalized = normalizeDraft(draft);
    const nextSortOrder =
        draft.sortOrder ??
        storage.items.reduce((maximum, item) => Math.max(maximum, item.sortOrder + 1), 0);
    const item: PromptSnippet = {
        id: options.id,
        ...normalized,
        sortOrder: nextSortOrder,
        lastUsedAt: null,
        createdAt: options.now,
        updatedAt: options.now,
    };
    return createEmptyPromptSnippetStorage([...storage.items, item]);
}

export function updatePromptSnippet(
    storage: PromptSnippetStorage,
    id: string,
    draft: PromptSnippetDraft,
    now: string
): PromptSnippetStorage {
    const existing = storage.items.find((item) => item.id === id);
    if (!existing) {
        throw new PromptSnippetValidationError('not_found');
    }
    const normalized = normalizeDraft(draft);
    return createEmptyPromptSnippetStorage(
        storage.items.map((item) =>
            item.id === id
                ? {
                      ...item,
                      ...normalized,
                      sortOrder: draft.sortOrder ?? item.sortOrder,
                      updatedAt: now,
                  }
                : item
        )
    );
}

export function removePromptSnippet(
    storage: PromptSnippetStorage,
    id: string
): PromptSnippetStorage {
    return createEmptyPromptSnippetStorage(storage.items.filter((item) => item.id !== id));
}

export function markPromptSnippetUsed(
    storage: PromptSnippetStorage,
    id: string,
    lastUsedAt: string
): PromptSnippetStorage {
    return {
        schemaVersion: PROMPT_SNIPPET_SCHEMA_VERSION,
        items: storage.items.map((item) =>
            item.id === id ? { ...item, lastUsedAt } : clonePromptSnippet(item)
        ),
    };
}

export function toPromptSnippetStorage(
    value: PromptSnippetStorage | PromptSnippetSettings
): PromptSnippetStorage {
    return {
        schemaVersion: PROMPT_SNIPPET_SCHEMA_VERSION,
        items: sortPromptSnippets(value.items).map(clonePromptSnippet),
    };
}

function normalizeDraft(
    draft: PromptSnippetDraft
): Omit<PromptSnippetDraft, 'sortOrder'> & { title: string } {
    const title = draft.title.trim();
    if (!title) {
        throw new PromptSnippetValidationError('empty_title');
    }
    if (title.length > PROMPT_SNIPPET_TITLE_MAX_LENGTH) {
        throw new PromptSnippetValidationError('title_too_long');
    }
    if (!draft.body.trim()) {
        throw new PromptSnippetValidationError('empty_body');
    }
    if (draft.body.length > PROMPT_SNIPPET_BODY_MAX_LENGTH) {
        throw new PromptSnippetValidationError('body_too_long');
    }
    return {
        title,
        body: draft.body,
        isFavorite: draft.isFavorite,
    };
}

function clonePromptSnippet(item: PromptSnippet): PromptSnippet {
    return { ...item };
}

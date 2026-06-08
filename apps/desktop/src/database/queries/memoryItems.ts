// Copyright (c) 2026. 千诚. Licensed under GPL v3

import { and, desc, eq, inArray, sql } from 'drizzle-orm';

import { containsSecretLikeContent } from '@/utils/secretLikeContent';

import { db } from '../index';
import { memoryItems } from '../schema';
import type {
    MemoryDirectoryItemEntity,
    MemoryItemCreateData,
    MemoryItemEntity,
    MemoryItemUpdateData,
} from '../types';

function normalizeMemoryTitle(title: string): string {
    return title.trim().replace(/\s+/g, ' ').toLocaleLowerCase();
}

function normalizeMemoryIds(ids: number[]): number[] {
    return Array.from(new Set(ids.filter((id) => Number.isInteger(id) && id > 0)));
}

function normalizeRequiredMemoryField(
    field: 'title' | 'applicability' | 'content',
    value: string | undefined
): string | undefined {
    if (value === undefined) {
        return undefined;
    }

    const normalized = value.trim();
    if (!normalized) {
        throw new Error(`Memory ${field} cannot be empty.`);
    }

    return normalized;
}

function normalizeMemoryCreateData(data: MemoryItemCreateData): MemoryItemCreateData {
    return {
        ...data,
        title: normalizeRequiredMemoryField('title', data.title) ?? data.title,
        applicability:
            normalizeRequiredMemoryField('applicability', data.applicability) ?? data.applicability,
        content: normalizeRequiredMemoryField('content', data.content) ?? data.content,
    };
}

function normalizeMemoryUpdateData(patch: MemoryItemUpdateData): MemoryItemUpdateData {
    const normalizedPatch: MemoryItemUpdateData = { ...patch };
    const title = normalizeRequiredMemoryField('title', patch.title);
    const applicability = normalizeRequiredMemoryField('applicability', patch.applicability);
    const content = normalizeRequiredMemoryField('content', patch.content);

    if (title !== undefined) {
        normalizedPatch.title = title;
    }
    if (applicability !== undefined) {
        normalizedPatch.applicability = applicability;
    }
    if (content !== undefined) {
        normalizedPatch.content = content;
    }

    return normalizedPatch;
}

function assertNoSecretLikeMemoryFields(data: {
    title?: string | null;
    applicability?: string | null;
    content?: string | null;
}) {
    const fields = [data.title, data.applicability, data.content].filter(
        (value): value is string => typeof value === 'string'
    );
    if (fields.some((value) => containsSecretLikeContent(value))) {
        throw new Error('Refusing to store secret-like content in memory.');
    }
}

export const findEnabledMemoryDirectoryItems = async (): Promise<MemoryDirectoryItemEntity[]> =>
    await db
        .select({
            id: memoryItems.id,
            title: memoryItems.title,
            applicability: memoryItems.applicability,
            enabled: memoryItems.enabled,
            updated_at: memoryItems.updated_at,
        })
        .from(memoryItems)
        .where(eq(memoryItems.enabled, 1))
        .orderBy(desc(memoryItems.updated_at), desc(memoryItems.id))
        .all();

export const findMemoryDirectoryItems = async (): Promise<MemoryDirectoryItemEntity[]> =>
    await db
        .select({
            id: memoryItems.id,
            title: memoryItems.title,
            applicability: memoryItems.applicability,
            enabled: memoryItems.enabled,
            updated_at: memoryItems.updated_at,
        })
        .from(memoryItems)
        .orderBy(desc(memoryItems.enabled), desc(memoryItems.updated_at), desc(memoryItems.id))
        .all();

export const readEnabledMemoryItemsByIds = async (ids: number[]): Promise<MemoryItemEntity[]> => {
    const uniqueIds = normalizeMemoryIds(ids);
    if (uniqueIds.length === 0) {
        return [];
    }

    return await db
        .select()
        .from(memoryItems)
        .where(and(eq(memoryItems.enabled, 1), inArray(memoryItems.id, uniqueIds)))
        .orderBy(desc(memoryItems.updated_at), desc(memoryItems.id))
        .all();
};

export const readMemoryItemsByIds = async (ids: number[]): Promise<MemoryItemEntity[]> => {
    const uniqueIds = normalizeMemoryIds(ids);
    if (uniqueIds.length === 0) {
        return [];
    }

    return await db
        .select()
        .from(memoryItems)
        .where(inArray(memoryItems.id, uniqueIds))
        .orderBy(desc(memoryItems.enabled), desc(memoryItems.updated_at), desc(memoryItems.id))
        .all();
};

export const createMemoryItem = async (data: MemoryItemCreateData): Promise<MemoryItemEntity> => {
    const normalizedData = normalizeMemoryCreateData(data);
    assertNoSecretLikeMemoryFields(normalizedData);
    const created = await db.insert(memoryItems).values(normalizedData).returning().get();
    if (!created || created.id === undefined) {
        throw new Error('Failed to create memory item');
    }
    return created;
};

export const updateMemoryItem = async (
    id: number,
    patch: MemoryItemUpdateData
): Promise<MemoryItemEntity | undefined> => {
    const normalizedPatch = normalizeMemoryUpdateData(patch);
    assertNoSecretLikeMemoryFields(normalizedPatch);
    const updated = await db
        .update(memoryItems)
        .set({
            ...normalizedPatch,
            updated_at: sql`datetime('now')`,
        })
        .where(eq(memoryItems.id, id))
        .returning()
        .get();

    return updated && updated.id !== undefined ? updated : undefined;
};

export const disableMemoryItem = async (id: number): Promise<MemoryItemEntity | undefined> => {
    const disabled = await db
        .update(memoryItems)
        .set({
            enabled: 0,
            updated_at: sql`datetime('now')`,
        })
        .where(and(eq(memoryItems.id, id), eq(memoryItems.enabled, 1)))
        .returning()
        .get();

    return disabled && disabled.id !== undefined ? disabled : undefined;
};

export const deleteMemoryItem = async (id: number): Promise<MemoryItemEntity | undefined> => {
    const deleted = await db.delete(memoryItems).where(eq(memoryItems.id, id)).returning().get();

    return deleted && deleted.id !== undefined ? deleted : undefined;
};

export const findMemoryItemByNormalizedTitle = async (
    title: string
): Promise<MemoryItemEntity | undefined> => {
    const target = normalizeMemoryTitle(title);
    if (!target) {
        return undefined;
    }

    const rows = await db.select().from(memoryItems).where(eq(memoryItems.enabled, 1)).all();
    return rows.find((row) => normalizeMemoryTitle(row.title) === target);
};

export const touchMemoryItemsLastUsed = async (
    ids: number[],
    lastUsedAt = new Date().toISOString()
): Promise<void> => {
    const uniqueIds = normalizeMemoryIds(ids);
    if (uniqueIds.length === 0) {
        return;
    }

    await db
        .update(memoryItems)
        .set({ last_used_at: lastUsedAt })
        .where(inArray(memoryItems.id, uniqueIds))
        .run();
};

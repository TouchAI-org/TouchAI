import { asc, eq } from 'drizzle-orm';

import { db } from '../index';
import {
    type ExternalAgent,
    externalAgents,
    type ExternalAgentUpdate,
    type NewExternalAgent,
} from '../schema';

export const findAllExternalAgents = async (): Promise<ExternalAgent[]> =>
    db.select().from(externalAgents).orderBy(asc(externalAgents.name)).all();

export const findExternalAgentById = async (id: number): Promise<ExternalAgent | undefined> =>
    db.select().from(externalAgents).where(eq(externalAgents.id, id)).get();

export const findExternalAgentByUrl = async (url: string): Promise<ExternalAgent | undefined> =>
    db.select().from(externalAgents).where(eq(externalAgents.url, url)).get();

export const createExternalAgent = async (data: NewExternalAgent): Promise<ExternalAgent> => {
    const created = await db.insert(externalAgents).values(data).returning().get();
    if (!created) throw new Error('EXTERNAL_AGENT_CREATE_FAILED');
    return created;
};

export const updateExternalAgent = async (
    id: number,
    data: ExternalAgentUpdate
): Promise<ExternalAgent | undefined> =>
    db
        .update(externalAgents)
        .set({ ...data, updated_at: new Date().toISOString() })
        .where(eq(externalAgents.id, id))
        .returning()
        .get();

export const deleteExternalAgent = async (id: number): Promise<void> => {
    await db.delete(externalAgents).where(eq(externalAgents.id, id)).run();
};

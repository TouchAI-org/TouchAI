import {
    closeTestDatabases,
    openMigratedDatabase,
    routeQueriesTo,
} from '@tests/database/sqliteHarness';
import { afterEach, describe, expect, it } from 'vitest';

import type { ToolInvocationScope, ToolOutcome, ToolSkillMetadata } from '@/modules/tools';
import { createActivateSkillTools, createBuiltinRegistrations, createTools } from '@/modules/tools';

afterEach(closeTestDatabases);

describe('given skill metadata is captured for an authorized turn', () => {
    it('user gets an audited rejection without loading instructions when the task context budget is exhausted', async () => {
        routeQueriesTo(openMigratedDatabase());
        const catalog = createBuiltinRegistrations(
            createActivateSkillTools({
                messages: { t: (key) => key, tt: (text) => text },
                skills: {
                    discover: async () => [
                        { name: 'fixture', description: 'instructions', path: '/fixture/SKILL.md' },
                    ],
                    load: async ([selected]) => [
                        { ...selected!, hash: 'hash', contextText: 'must not reach model' },
                    ],
                },
            })
        );
        await catalog.synchronize();
        const saved: ToolOutcome[] = [];
        const tools = createTools({
            registrations: catalog.registrations,
            formatError: (code) => code,
            beginAudit: async () => ({
                receiptKey: 'receipt',
                finish: async (outcome) => {
                    saved.push(outcome);
                },
            }),
        });
        try {
            const scope = {
                iteration: 0,
                restriction: 'skill_context_limit',
            } as ToolInvocationScope;
            const result = await (
                await tools.snapshot()
            ).execute(
                { id: 'call', name: 'builtin__activate_skill', arguments: '{"name":"fixture"}' },
                scope
            );
            expect(result).toMatchObject({
                result: 'skill_context_limit',
                isError: true,
                sideEffect: 'none',
                receiptKey: 'receipt',
            });
            expect(saved).toEqual([result]);
            expect(result.persistedResult).toBeUndefined();
        } finally {
            tools.dispose();
        }
    });

    it('user gets model context and the unchanged persisted summary for the advertised skill', async () => {
        routeQueriesTo(openMigratedDatabase());
        const catalog = createBuiltinRegistrations(
            createActivateSkillTools({
                messages: { t: (key) => key, tt: (text) => text },
                skills: {
                    discover: async () => [
                        { name: 'fixture', description: 'instructions', path: '/fixture/SKILL.md' },
                    ],
                    load: async ([selected]) => [
                        {
                            ...selected!,
                            hash: 'fixture-hash',
                            contextText: '<skill>private instructions</skill>',
                        },
                    ],
                },
            })
        );
        await catalog.synchronize();
        const tools = createTools({
            registrations: catalog.registrations,
            formatError: (code) => code,
        });
        try {
            const snapshot = await tools.snapshot();
            expect(snapshot.declarations[0]?.description).toContain('/fixture/SKILL.md');
            const result = await snapshot.execute(
                { id: 'call', name: 'builtin__activate_skill', arguments: '{"name":"fixture"}' },
                { iteration: 0 }
            );
            expect(result).toMatchObject({
                result: '<skill>private instructions</skill>',
                isError: false,
            });
            expect(result.persistedResult).toBe(
                'skills.loaded\n/fixture/SKILL.md\nSHA-256: fixture-hash'
            );
            expect(result.persistedResult).not.toContain('private instructions');
        } finally {
            tools.dispose();
        }
    });

    it('user cannot load a replacement or disabled skill after its turn catalog is advertised', async () => {
        routeQueriesTo(openMigratedDatabase());
        let metadata: ToolSkillMetadata[] = [
            { name: 'fixture', description: 'original', path: '/original/SKILL.md' },
        ];
        const catalog = createBuiltinRegistrations(
            createActivateSkillTools({
                messages: { t: (key) => key, tt: (text) => text },
                skills: {
                    discover: async () => metadata,
                    load: async ([selected]) => [
                        { ...selected!, hash: 'hash', contextText: `loaded ${selected?.path}` },
                    ],
                },
            })
        );
        await catalog.synchronize();
        const tools = createTools({
            registrations: catalog.registrations,
            formatError: (code) => code,
        });
        try {
            const snapshot = await tools.snapshot();
            metadata = [
                { name: 'fixture', description: 'replacement', path: '/replacement/SKILL.md' },
            ];
            const replacement = await snapshot.execute(
                { id: 'one', name: 'builtin__activate_skill', arguments: '{"name":"fixture"}' },
                { iteration: 0 }
            );
            expect(replacement.isError).toBe(true);
            expect(replacement.result).not.toContain('loaded /replacement');
            metadata = [
                {
                    name: 'fixture',
                    description: 'original',
                    path: '/original/SKILL.md',
                    disabled: true,
                },
            ];
            const disabled = await snapshot.execute(
                { id: 'two', name: 'builtin__activate_skill', arguments: '{"name":"fixture"}' },
                { iteration: 0 }
            );
            expect(disabled.isError).toBe(true);
            expect(disabled.persistedResult).toBeUndefined();
        } finally {
            tools.dispose();
        }
    });
});

import { createToolsHostFixture } from '@tests/utils/toolsHost';
import { describe, expect, it } from 'vitest';

async function fixture() {
    const input = await createToolsHostFixture();
    const snapshot = () =>
        input.host.tools.snapshot({
            preparation: { taskId: input.taskId, currentModel: input.currentModel },
        });
    return { ...input, snapshot };
}

describe('given builtins use the production instance registry and existing SQLite configuration', () => {
    it('user receives every enabled shipped tool and no retired browser or unknown row', async () => {
        const input = await fixture();
        input.database.exec(
            "INSERT INTO built_in_tools (tool_id, display_name, enabled) VALUES ('ghost', 'Old tool', 1)"
        );
        const names = (await input.snapshot()).declarations.map((tool) => tool.name);
        expect(names).toEqual(
            expect.arrayContaining([
                'builtin__browser',
                'builtin__bash',
                'builtin__ask_user_question',
                'builtin__read',
            ])
        );
        expect(names).not.toContain('builtin__ghost');
        expect(names).not.toContain('builtin__browser_act');
        expect(new Set(names).size).toBe(names.length);
    });

    it('user disables tools and later declarations and effects both honor the saved choices', async () => {
        const input = await fixture();
        input.database.exec('UPDATE built_in_tools SET enabled = 0');
        const turn = await input.snapshot();
        expect(turn.declarations).toEqual([]);
        expect(
            await turn.execute(
                { id: 'disabled', name: 'builtin__bash', arguments: '{}' },
                { iteration: 1 }
            )
        ).toMatchObject({ isError: true, sideEffect: 'none', failureCode: 'tool_unavailable' });
    });

    it('user keeps saved configuration and disabled state after registry synchronization runs again', async () => {
        const input = await fixture();
        input.database.exec(
            `UPDATE built_in_tools SET enabled = 0, config_json = '{"timeoutMs":7000}' WHERE tool_id = 'bash'`
        );
        const before = input.database.prepare('SELECT * FROM built_in_tools ORDER BY id').all();
        await input.host.synchronize();
        expect(input.database.prepare('SELECT * FROM built_in_tools ORDER BY id').all()).toEqual(
            before
        );
    });

    it('user receives a missing shipped tool with existing default risk and configuration without resetting others', async () => {
        const input = await fixture();
        input.database.exec("DELETE FROM built_in_tools WHERE tool_id = 'bash'");
        await input.host.synchronize();
        expect(
            input.database
                .prepare(
                    "SELECT enabled, risk_level, config_json FROM built_in_tools WHERE tool_id = 'bash'"
                )
                .get()
        ).toMatchObject({
            enabled: 1,
            risk_level: 'high',
            config_json: expect.stringContaining('approvalMode'),
        });
    });

    it('user sees timeout declarations reflect the saved ceiling and retain no private capability in the wire schema', async () => {
        const input = await fixture();
        input.database.exec(
            `UPDATE built_in_tools SET config_json = '{"timeoutMs":7000}' WHERE tool_id = 'bash'`
        );
        const bash = (await input.snapshot()).declarations.find(
            (tool) => tool.name === 'builtin__bash'
        )!;
        expect(bash.input_schema.properties._meta).toMatchObject({
            properties: { timeoutMs: { minimum: 1000, maximum: 7000 } },
        });
        expect(JSON.stringify(bash.input_schema)).not.toContain('adaptiveTimeoutCeilingMs');
    });

    it('user receives no authority from a foreign or unregistered tool name', async () => {
        const input = await fixture();
        for (const name of ['mcp__1__query', 'bash', 'builtin__removed', 'builtin__browser_act']) {
            expect(
                await (
                    await input.snapshot()
                ).execute({ id: name, name, arguments: '{}' }, { iteration: 1 })
            ).toMatchObject({ isError: true, sideEffect: 'none', failureCode: 'tool_unavailable' });
        }
    });
});

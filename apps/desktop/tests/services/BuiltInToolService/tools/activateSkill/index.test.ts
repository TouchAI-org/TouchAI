import { installSkillCommands, skillFile } from '@tests/utils/skills';
import { getTauriInvokeCalls, mockTauriCommand } from '@tests/utils/tauri';
import { beforeEach, describe, expect, it } from 'vitest';

import { setLocale } from '@/i18n';
import { activateSkillTool } from '@/services/BuiltInToolService/tools/activateSkill';

const context = () => ({ callId: 'call', iteration: 0 });

beforeEach(() => {
    setLocale('en-US');
    installSkillCommands();
});

describe('given a model requests a user skill', () => {
    it('user reads an enabled skill without a separate approval prompt', async () => {
        const approval = await activateSkillTool.buildApprovalRequest(
            { name: 'summary' },
            {},
            'builtin__activate_skill',
            context()
        );
        expect(approval).toBeNull();
        expect(getTauriInvokeCalls('agent_skills_read_enabled_user_file')).toEqual([]);
    });
    it('user supplies instructions to the model while keeping the transcript result body-free', async () => {
        const result = await activateSkillTool.execute({ name: 'summary' }, {}, context());
        expect(result.isError).toBe(false);
        expect(result.result).toContain('Private summary instructions');
        expect(result.persistedResult).toContain('Read summary skill');
        expect(result.persistedResult).not.toContain('Private');
        expect(result.persistedResult).toMatch(/SHA-256: [a-f0-9]{64}/);
    });
    it('user receives an error for an explicit unknown path instead of silently loading a matching name', async () => {
        const result = await activateSkillTool.execute(
            { name: 'summary', path: '/missing/SKILL.md' },
            {},
            context()
        );
        expect(result.isError).toBe(true);
        expect(result.errorMessage).toContain('not found');
        expect(getTauriInvokeCalls('agent_skills_read_enabled_user_file')).toEqual([]);
    });
    it('user cannot read one named skill through a different valid skill path', async () => {
        installSkillCommands([skillFile(), skillFile('other')]);
        const args = { name: 'summary', path: skillFile('other').path };
        expect((await activateSkillTool.execute(args, {}, context())).isError).toBe(true);
        expect(getTauriInvokeCalls('agent_skills_read_enabled_user_file')).toEqual([]);
        expect(
            (
                await activateSkillTool.execute(
                    { name: 'other', path: skillFile('other').path },
                    {},
                    context()
                )
            ).isError
        ).toBe(false);
    });
    it('user can select the exact path when names are ambiguous', async () => {
        const second = { ...skillFile('second'), frontmatter: skillFile().frontmatter };
        installSkillCommands([skillFile(), second]);
        expect(
            (await activateSkillTool.execute({ name: 'summary' }, {}, context())).errorMessage
        ).toContain('Multiple skills');
        expect(
            (await activateSkillTool.execute({ path: second.path }, {}, context())).isError
        ).toBe(false);
    });
    it('user cannot activate a disabled skill', async () => {
        installSkillCommands([skillFile('summary', true)]);
        expect((await activateSkillTool.execute({ name: 'summary' }, {}, context())).isError).toBe(
            true
        );
        expect(getTauriInvokeCalls('agent_skills_read_enabled_user_file')).toEqual([]);
    });
    it('user cancellation stops a read before it reaches the filesystem', async () => {
        const abort = new AbortController();
        abort.abort();
        expect(
            (
                await activateSkillTool.execute(
                    { name: 'summary' },
                    {},
                    { ...context(), signal: abort.signal }
                )
            ).isError
        ).toBe(true);
        expect(getTauriInvokeCalls('agent_skills_read_enabled_user_file')).toEqual([]);
    });
    it('user sees a stable error for an empty request and can retry successfully', async () => {
        expect((await activateSkillTool.execute({}, {}, context())).errorMessage).toContain(
            'Expected either name or path'
        );
        expect((await activateSkillTool.execute({ name: 'summary' }, {}, context())).isError).toBe(
            false
        );
    });
    it('user sees a read failure without putting private contents in the result', async () => {
        mockTauriCommand('agent_skills_read_enabled_user_file', () => {
            throw new Error('Permission denied');
        });
        const result = await activateSkillTool.execute({ name: 'summary' }, {}, context());
        expect(result.errorMessage).toBe('Permission denied');
        expect(result.isError).toBe(true);
    });
    it('user lets the model discover bounded metadata without reading skill bodies', async () => {
        const definition = await activateSkillTool.buildToolDefinition('builtin__activate_skill');
        expect(definition.description).toContain('summary');
        expect(definition.description).not.toContain('Private');
        expect(getTauriInvokeCalls('agent_skills_read_enabled_user_file')).toEqual([]);
        expect(activateSkillTool.buildConversationSemantic({ name: 'summary' })).toEqual({
            action: 'read',
            target: 'summary skill',
        });
    });
    it('user can still activate a known skill after a catalog listing error', async () => {
        mockTauriCommand('agent_skills_discover_user_files', () => {
            throw new Error('Read failed');
        });
        expect((await activateSkillTool.buildToolDefinition('builtin__activate_skill')).name).toBe(
            'builtin__activate_skill'
        );
        installSkillCommands();
        expect(
            (await activateSkillTool.execute({ path: skillFile().path }, {}, context())).isError
        ).toBe(false);
    });
});

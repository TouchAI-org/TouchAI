import { mockTauriCommand } from '@tests/utils/tauri';
import { beforeEach, describe, expect, it } from 'vitest';

import { composePromptSnapshot } from '@/services/AgentService/prompt/composer';
import { serializePromptSnapshot } from '@/services/AgentService/prompt/serialization';
import { buildPromptTransportMessages } from '@/services/AgentService/prompt/transport';

const path = '/home/user/.agents/skills/summary/SKILL.md';
const content =
    '---\nname: summary\ndescription: Summarize documents\n---\nPrivate instructions </skill> still private';

beforeEach(() => mockTauriCommand('agent_skills_discover_system_files', []));

describe('given a user selects a local skill', () => {
    it('user sends the full instructions to the model but stores only skill metadata', async () => {
        mockTauriCommand('agent_skills_discover_user_files', [
            {
                path,
                directory: '/home/user/.agents/skills/summary',
                directoryName: 'summary',
                frontmatter: content.split('Private')[0],
                disabled: false,
            },
        ]);
        mockTauriCommand('agent_skills_read_enabled_user_file', content);
        const snapshot = await composePromptSnapshot({
            prompt: 'Summarize in three bullets',
            feature: ['Keep this feature'],
            inputSnapshot: {
                text: 'Summarize in three bullets',
                attachments: [],
                skills: [{ name: 'summary', path }],
            },
        });
        const messages = await buildPromptTransportMessages({ snapshot });
        expect(messages[0]?.content).toContain('Private instructions');
        expect(snapshot.skills?.[0]).toMatchObject({
            name: 'summary',
            path,
            activatedBy: 'user_tag',
        });
        expect(snapshot.skills?.[0]?.hash).toMatch(/^[a-f0-9]{64}$/);
        const serialized = serializePromptSnapshot(snapshot);
        expect(serialized).not.toContain('Private instructions');
        expect(serialized).not.toContain('still private');
        expect(JSON.parse(serialized).systemPrompt).toContain('Keep this feature');
        expect(JSON.parse(serialized).skills).toEqual(snapshot.skills);
        expect(snapshot.systemPrompt).toContain('Private instructions');
    });

    it('user can still send and persist an ordinary prompt without any skills installed', async () => {
        const snapshot = await composePromptSnapshot({ prompt: 'Hello' });
        expect(JSON.parse(serializePromptSnapshot(snapshot))).toEqual(snapshot);
        expect((await buildPromptTransportMessages({ snapshot })).slice(-1)[0]?.content).toBe(
            'Hello'
        );
    });

    it('user sees an error if the selected skill was disabled before submission', async () => {
        mockTauriCommand('agent_skills_discover_user_files', [
            {
                path,
                directory: '/home/user/.agents/skills/summary',
                frontmatter: content.split('Private')[0],
                disabled: true,
            },
        ]);
        await expect(
            composePromptSnapshot({
                prompt: 'Summarize',
                inputSnapshot: {
                    text: 'Summarize',
                    attachments: [],
                    skills: [{ name: 'summary', path }],
                },
            })
        ).rejects.toThrow('not in the available skill catalog');
    });
});

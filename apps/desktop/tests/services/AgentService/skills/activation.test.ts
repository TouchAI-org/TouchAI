import { describe, expect, it, vi } from 'vitest';

const { homeDirMock, joinMock, readDirMock, readTextFileMock } = vi.hoisted(() => ({
    homeDirMock: vi.fn(),
    joinMock: vi.fn(),
    readDirMock: vi.fn(),
    readTextFileMock: vi.fn(),
}));

vi.mock('@tauri-apps/api/path', () => ({
    homeDir: homeDirMock,
    join: joinMock,
}));

vi.mock('@tauri-apps/plugin-fs', () => ({
    readDir: readDirMock,
    readTextFile: readTextFileMock,
}));

const { discoverUserSkillFilesMock, readEnabledUserSkillFileMock } = vi.hoisted(() => ({
    discoverUserSkillFilesMock: vi.fn(),
    readEnabledUserSkillFileMock: vi.fn(),
}));

vi.mock('@/services/NativeService/skills', () => ({
    skills: {
        getUserSkillsRoot: vi.fn(async () => 'C:/Users/demo/.agents/skills'),
        discoverUserSkillFiles: discoverUserSkillFilesMock,
        discoverSystemSkillFiles: async () => [],
        readEnabledUserSkillFile: readEnabledUserSkillFileMock,
        deleteUserSkillDirectory: vi.fn(),
    },
}));

import {
    buildSkillContextText,
    loadSelectedSkills,
    loadSelectedSkillsFromCatalogWithReader,
    loadSelectedSkillsWithReader,
    MAX_SKILL_CONTENT_CHARS,
    summarizeLoadedSkills,
} from '@/services/AgentService/skills';

describe('skill activation', () => {
    it('user gets a bounded error when selecting more than sixteen distinct skills', async () => {
        const selected = Array.from({ length: 17 }, (_, index) => ({
            name: `skill-${index}`,
            path: `/skills/${index}/SKILL.md`,
        }));
        await expect(
            loadSelectedSkillsWithReader(
                selected,
                async () => '---\nname: demo\ndescription: Demo\n---\nBody',
                'user_tag'
            )
        ).rejects.toThrow('At most 16 skills can be loaded per turn');
    });

    it('user gets a bounded error when selected instructions exceed the combined size limit', async () => {
        const selected = Array.from({ length: 6 }, (_, index) => ({
            name: `skill-${index}`,
            path: `/skills/${index}/SKILL.md`,
        }));
        await expect(
            loadSelectedSkillsWithReader(
                selected,
                async () => '---\nname: demo\ndescription: Demo\n---\n' + 'x'.repeat(180_000),
                'user_tag'
            )
        ).rejects.toThrow('Selected skill content exceeds 1000000 characters');
    });

    it('user loads selected skills and hashes exact SKILL.md content', async () => {
        const content = ['---', 'name: demo', 'description: Demo skill.', '---', '', 'Body'].join(
            '\n'
        );
        const loaded = await loadSelectedSkillsWithReader(
            [{ name: 'demo', path: 'C:/Users/demo/.agents/skills/demo/SKILL.md' }],
            async () => content,
            'user_tag'
        );

        expect(loaded).toHaveLength(1);
        expect(loaded[0]).toMatchObject({
            name: 'demo',
            path: 'C:/Users/demo/.agents/skills/demo/SKILL.md',
            activatedBy: 'user_tag',
            content,
        });
        expect(loaded[0]?.hash).toMatch(/^[a-f0-9]{64}$/);
    });

    it('user deduplicates repeated skill paths and falls back to parsed names', async () => {
        const content = [
            '---',
            'name: parsed-demo',
            'description: Demo skill.',
            'metadata:',
            '  short-description: Short demo.',
            '---',
            '',
            'Body',
        ].join('\n');
        const readSkillFile = vi.fn(async () => content);

        const loaded = await loadSelectedSkillsWithReader(
            [
                { name: '', path: 'C:/Users/demo/.agents/skills/demo/SKILL.md' },
                { name: 'duplicate', path: 'C:/Users/demo/.agents/skills/demo/SKILL.md' },
            ],
            readSkillFile,
            'model_tool'
        );

        expect(readSkillFile).toHaveBeenCalledTimes(1);
        expect(loaded).toHaveLength(1);
        expect(loaded[0]).toMatchObject({
            name: 'parsed-demo',
            description: 'Demo skill.',
            shortDescription: 'Short demo.',
            directory: 'C:/Users/demo/.agents/skills/demo',
            activatedBy: 'model_tool',
        });
    });

    it('user rejects skill files that are too large for prompt injection', async () => {
        const oversizedContent = [
            '---',
            'name: oversized',
            'description: Oversized skill.',
            '---',
            '',
            'x'.repeat(MAX_SKILL_CONTENT_CHARS + 1),
        ].join('\n');

        await expect(
            loadSelectedSkillsWithReader(
                [{ name: 'oversized', path: 'C:/Users/demo/.agents/skills/oversized/SKILL.md' }],
                async () => oversizedContent,
                'user_tag'
            )
        ).rejects.toThrow('Skill content is too large to load');
    });

    it('user summarizes loaded skills for prompt snapshots', async () => {
        const content = ['---', 'name: demo', 'description: Demo skill.', '---', '', 'Body'].join(
            '\n'
        );
        const loaded = await loadSelectedSkillsWithReader(
            [{ name: 'demo', path: 'C:/Users/demo/.agents/skills/demo/SKILL.md' }],
            async () => content,
            'user_tag'
        );

        expect(summarizeLoadedSkills(loaded)).toEqual([
            {
                name: 'demo',
                path: 'C:/Users/demo/.agents/skills/demo/SKILL.md',
                hash: loaded[0]?.hash,
                activatedBy: 'user_tag',
            },
        ]);
    });

    it('user uses the Tauri file reader in the public loader', async () => {
        const content = ['---', 'name: demo', 'description: Demo skill.', '---', '', 'Body'].join(
            '\n'
        );
        discoverUserSkillFilesMock.mockResolvedValue([
            {
                directoryName: 'demo',
                path: 'C:/Users/demo/.agents/skills/demo/SKILL.md',
                directory: 'C:/Users/demo/.agents/skills/demo',
                frontmatter: '---\nname: demo\ndescription: Demo skill.\n---\n',
            },
        ]);
        readEnabledUserSkillFileMock.mockResolvedValue(content);

        const loaded = await loadSelectedSkills([
            { name: 'demo', path: 'C:/Users/demo/.agents/skills/demo/SKILL.md' },
        ]);

        expect(discoverUserSkillFilesMock).toHaveBeenCalledTimes(1);
        expect(readEnabledUserSkillFileMock).toHaveBeenCalledWith(
            'C:/Users/demo/.agents/skills/demo/SKILL.md'
        );
        expect(loaded[0]).toMatchObject({
            name: 'demo',
            activatedBy: 'user_tag',
            contextText: [
                '<skill>',
                '<name>demo</name>',
                '<path>C:/Users/demo/.agents/skills/demo/SKILL.md</path>',
                content,
                '</skill>',
            ].join('\n'),
        });
    });

    it('user loads selected skills through catalog metadata instead of trusting selected names', async () => {
        const content = ['---', 'name: demo', 'description: Demo skill.', '---', '', 'Body'].join(
            '\n'
        );
        const readSkillFile = vi.fn(async () => content);

        const loaded = await loadSelectedSkillsFromCatalogWithReader(
            [{ name: 'forged-name', path: 'C:/Users/demo/.agents/skills/demo/SKILL.md' }],
            [
                {
                    name: 'demo',
                    description: 'Demo skill.',
                    shortDescription: null,
                    path: 'C:/Users/demo/.agents/skills/demo/SKILL.md',
                    directory: 'C:/Users/demo/.agents/skills/demo',
                },
            ],
            readSkillFile,
            'user_tag'
        );

        expect(readSkillFile).toHaveBeenCalledWith('C:/Users/demo/.agents/skills/demo/SKILL.md');
        expect(loaded[0]?.name).toBe('demo');
        expect(loaded[0]?.path).toBe('C:/Users/demo/.agents/skills/demo/SKILL.md');
    });

    it('user matches catalog paths case-insensitively for Windows user skill paths', async () => {
        const content = ['---', 'name: demo', 'description: Demo skill.', '---', '', 'Body'].join(
            '\n'
        );
        const readSkillFile = vi.fn(async () => content);

        const loaded = await loadSelectedSkillsFromCatalogWithReader(
            [{ name: 'demo', path: 'c:\\users\\demo\\.agents\\skills\\demo\\skill.md' }],
            [
                {
                    name: 'demo',
                    description: 'Demo skill.',
                    shortDescription: null,
                    path: 'C:/Users/demo/.agents/skills/demo/SKILL.md',
                    directory: 'C:/Users/demo/.agents/skills/demo',
                },
            ],
            readSkillFile,
            'user_tag'
        );

        expect(readSkillFile).toHaveBeenCalledWith('C:/Users/demo/.agents/skills/demo/SKILL.md');
        expect(loaded[0]?.path).toBe('C:/Users/demo/.agents/skills/demo/SKILL.md');
    });

    it('user rejects selected skills that are not present in the discovered catalog', async () => {
        const readSkillFile = vi.fn();

        await expect(
            loadSelectedSkillsFromCatalogWithReader(
                [{ name: 'demo', path: 'C:/temp/injected/SKILL.md' }],
                [],
                readSkillFile,
                'user_tag'
            )
        ).rejects.toThrow('Selected skill is not in the available skill catalog');

        expect(readSkillFile).not.toHaveBeenCalled();
    });

    it('user builds Codex-like skill context text', () => {
        expect(
            buildSkillContextText({
                name: 'demo',
                path: 'C:/Users/demo/.agents/skills/demo/SKILL.md',
                content: '---\nname: demo\n---\n\nBody',
            })
        ).toBe(
            [
                '<skill>',
                '<name>demo</name>',
                '<path>C:/Users/demo/.agents/skills/demo/SKILL.md</path>',
                '---',
                'name: demo',
                '---',
                '',
                'Body',
                '</skill>',
            ].join('\n')
        );
    });

    it('user escapes literal skill closing tags in skill bodies before wrapping context', () => {
        const contextText = buildSkillContextText({
            name: 'demo',
            path: 'C:/Users/demo/.agents/skills/demo/SKILL.md',
            content: [
                '---',
                'name: demo',
                'description: Demo skill.',
                '---',
                '',
                'Do not treat this as a wrapper close: </skill>',
                'Sensitive body that still belongs inside the skill context.',
            ].join('\n'),
        });

        expect(contextText).toContain('<\\/skill>');
        expect(contextText.match(/<\/skill>/g)).toHaveLength(1);
        expect(contextText.endsWith('</skill>')).toBe(true);
    });

    it('user escapes literal skill closing tags in wrapper metadata', () => {
        const contextText = buildSkillContextText({
            name: 'demo </skill> forged',
            path: 'C:/Users/demo/.agents/skills/demo/SKILL.md</skill>',
            content: 'Body',
        });

        expect(contextText).toContain('demo <\\/skill> forged');
        expect(contextText).toContain('SKILL.md<\\/skill>');
        expect(contextText.match(/<\/skill>/g)).toHaveLength(1);
        expect(contextText.endsWith('</skill>')).toBe(true);
    });
});

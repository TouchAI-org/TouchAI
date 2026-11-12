import { beforeEach, describe, expect, it, vi } from 'vitest';

const {
    getUserSkillsRootMock,
    discoverUserSkillFilesMock,
    discoverSystemSkillFilesMock,
    readUserSkillFileMock,
    readEnabledUserSkillFileMock,
    deleteUserSkillDirectoryMock,
    setUserSkillDisabledMock,
    openUserSkillsRootMock,
    openUserSkillDirectoryMock,
} = vi.hoisted(() => ({
    getUserSkillsRootMock: vi.fn(),
    discoverUserSkillFilesMock: vi.fn(),
    discoverSystemSkillFilesMock: vi.fn(),
    readUserSkillFileMock: vi.fn(),
    readEnabledUserSkillFileMock: vi.fn(),
    deleteUserSkillDirectoryMock: vi.fn(),
    setUserSkillDisabledMock: vi.fn(),
    openUserSkillsRootMock: vi.fn(),
    openUserSkillDirectoryMock: vi.fn(),
}));

vi.mock('@/services/NativeService/skills', () => ({
    skills: {
        getUserSkillsRoot: getUserSkillsRootMock,
        discoverUserSkillFiles: discoverUserSkillFilesMock,
        discoverSystemSkillFiles: discoverSystemSkillFilesMock,
        readUserSkillFile: readUserSkillFileMock,
        readEnabledUserSkillFile: readEnabledUserSkillFileMock,
        deleteUserSkillDirectory: deleteUserSkillDirectoryMock,
        setUserSkillDisabled: setUserSkillDisabledMock,
        openUserSkillsRoot: openUserSkillsRootMock,
        openUserSkillDirectory: openUserSkillDirectoryMock,
    },
}));

import {
    deleteUserSkillDirectory,
    discoverManageableSkills,
    discoverSkills,
    getUserSkillsRoot,
    openUserSkillDirectory,
    openUserSkillsRoot,
    readEnabledSkillContent,
    readSkillContent,
    setUserSkillDisabled,
} from '@/services/AgentService/skills';

function skillFile(
    overrides: Partial<{
        directoryName: string;
        path: string;
        directory: string;
        frontmatter: string;
        disabled: boolean;
        scope: 'app' | 'shared';
    }> = {}
) {
    return {
        directoryName: 'demo',
        path: 'C:/Users/demo/.agents/skills/demo/SKILL.md',
        directory: 'C:/Users/demo/.agents/skills/demo',
        frontmatter: ['---', 'name: demo', 'description: Demo skill.', '---', ''].join('\n'),
        disabled: false,
        scope: 'shared' as const,
        ...overrides,
    };
}

beforeEach(() => {
    vi.clearAllMocks();
    getUserSkillsRootMock.mockResolvedValue('C:/Users/demo/.agents/skills');
    discoverUserSkillFilesMock.mockResolvedValue([skillFile()]);
    discoverSystemSkillFilesMock.mockResolvedValue([]);
    readUserSkillFileMock.mockResolvedValue('# Skill body');
    readEnabledUserSkillFileMock.mockResolvedValue('# Enabled skill body');
    deleteUserSkillDirectoryMock.mockResolvedValue(undefined);
    setUserSkillDisabledMock.mockResolvedValue(undefined);
    openUserSkillsRootMock.mockResolvedValue(undefined);
    openUserSkillDirectoryMock.mockResolvedValue(undefined);
});

describe('skills catalog', () => {
    it('user given skills from different sources when opening either catalog then sees one alphabetical sequence', async () => {
        discoverSystemSkillFilesMock.mockResolvedValue([
            skillFile({
                path: '/app/skills/.system/widget/SKILL.md',
                frontmatter: '---\nname: widget\ndescription: Widget helper\n---\n',
                scope: 'app',
            }),
        ]);
        discoverUserSkillFilesMock.mockResolvedValue([
            skillFile({ frontmatter: '---\nname: zebra\ndescription: Zebra helper\n---\n' }),
            skillFile({
                path: '/app/skills/alpha/SKILL.md',
                frontmatter: '---\nname: alpha\ndescription: Alpha helper\n---\n',
                scope: 'app',
            }),
        ]);
        for (const discover of [discoverSkills, discoverManageableSkills]) {
            expect((await discover()).map((skill) => skill.name)).toEqual([
                'alpha',
                'widget',
                'zebra',
            ]);
        }
    });

    it('user given same-name skills in both roots when discovering then retains each native source despite conflicting Markdown metadata', async () => {
        discoverUserSkillFilesMock.mockResolvedValue([
            skillFile({ scope: 'shared' }),
            skillFile({
                path: 'D:/TouchAI/skills/demo/SKILL.md',
                directory: 'D:/TouchAI/skills/demo',
                scope: 'app',
                frontmatter: '---\nname: demo\ndescription: App helper\nscope: shared\n---\n',
            }),
        ]);
        for (const discover of [discoverSkills, discoverManageableSkills]) {
            expect(await discover()).toEqual(
                expect.arrayContaining([
                    expect.objectContaining({
                        name: 'demo',
                        path: skillFile().path,
                        scope: 'shared',
                    }),
                    expect.objectContaining({
                        name: 'demo',
                        path: 'D:/TouchAI/skills/demo/SKILL.md',
                        scope: 'app',
                    }),
                ])
            );
        }
    });
    it('user discovers enabled user skills from bounded native metadata', async () => {
        discoverUserSkillFilesMock.mockResolvedValue([
            skillFile({
                directoryName: 'disabled',
                path: 'C:/Users/demo/.agents/skills/disabled/SKILL.md',
                directory: 'C:/Users/demo/.agents/skills/disabled',
                frontmatter: [
                    '---',
                    'name: disabled',
                    'description: Disabled skill.',
                    '---',
                    '',
                ].join('\n'),
                disabled: true,
            }),
            skillFile({
                directoryName: 'enabled',
                path: 'C:/Users/demo/.agents/skills/enabled/SKILL.md',
                directory: 'C:/Users/demo/.agents/skills/enabled',
                frontmatter: [
                    '---',
                    'name: enabled',
                    'description: Enabled skill.',
                    '---',
                    '',
                ].join('\n'),
            }),
        ]);

        await expect(getUserSkillsRoot()).resolves.toBe('C:/Users/demo/.agents/skills');
        const skills = await discoverSkills();

        expect(skills).toMatchObject([
            {
                name: 'enabled',
                disabled: false,
                path: 'C:/Users/demo/.agents/skills/enabled/SKILL.md',
            },
        ]);
        expect(discoverUserSkillFilesMock).toHaveBeenCalledTimes(1);
        expect(readUserSkillFileMock).not.toHaveBeenCalled();
    });

    it('user discovers manageable user skills including disabled entries', async () => {
        discoverUserSkillFilesMock.mockResolvedValue([
            skillFile({
                directoryName: 'disabled',
                path: 'C:/Users/demo/.agents/skills/disabled/SKILL.md',
                directory: 'C:/Users/demo/.agents/skills/disabled',
                frontmatter: [
                    '---',
                    'name: disabled',
                    'description: Disabled skill.',
                    '---',
                    '',
                ].join('\n'),
                disabled: true,
            }),
            skillFile({
                directoryName: 'enabled',
                path: 'C:/Users/demo/.agents/skills/enabled/SKILL.md',
                directory: 'C:/Users/demo/.agents/skills/enabled',
                frontmatter: [
                    '---',
                    'name: enabled',
                    'description: Enabled skill.',
                    '---',
                    '',
                ].join('\n'),
            }),
        ]);

        const skills = await discoverManageableSkills();

        expect(skills.map((skill) => [skill.name, skill.disabled])).toEqual([
            ['disabled', true],
            ['enabled', false],
        ]);
    });

    it('user skips invalid skill metadata without failing the catalog', async () => {
        const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
        discoverUserSkillFilesMock.mockResolvedValue([
            skillFile({
                directoryName: 'bad',
                path: 'C:/Users/demo/.agents/skills/bad/SKILL.md',
                directory: 'C:/Users/demo/.agents/skills/bad',
                frontmatter: 'bad file',
            }),
            skillFile({
                directoryName: 'good',
                path: 'C:/Users/demo/.agents/skills/good/SKILL.md',
                directory: 'C:/Users/demo/.agents/skills/good',
                frontmatter: ['---', 'name: good', 'description: Good skill.', '---', ''].join(
                    '\n'
                ),
            }),
        ]);

        expect(await discoverManageableSkills()).toMatchObject([{ name: 'good' }]);
        warnSpy.mockRestore();
    });

    it('user reads selected user skill content from its SKILL.md path', async () => {
        await expect(
            readSkillContent({
                path: 'C:/Users/demo/.agents/skills/demo/SKILL.md',
            })
        ).resolves.toBe('# Skill body');

        expect(readUserSkillFileMock).toHaveBeenCalledWith(
            'C:/Users/demo/.agents/skills/demo/SKILL.md'
        );
    });

    it('user reads enabled selected user skill content through the session-safe reader', async () => {
        await expect(
            readEnabledSkillContent({
                path: 'C:/Users/demo/.agents/skills/demo/SKILL.md',
            })
        ).resolves.toBe('# Enabled skill body');

        expect(readEnabledUserSkillFileMock).toHaveBeenCalledWith(
            'C:/Users/demo/.agents/skills/demo/SKILL.md'
        );
        expect(readUserSkillFileMock).not.toHaveBeenCalled();
    });

    it('user delegates skill management actions to native commands', async () => {
        const skill = {
            path: 'C:/Users/demo/.agents/skills/demo/SKILL.md',
            directory: 'C:/Users/demo/.agents/skills/demo',
        };

        await setUserSkillDisabled(skill, true);
        await deleteUserSkillDirectory(skill);
        await openUserSkillsRoot();
        await openUserSkillDirectory(skill);

        expect(setUserSkillDisabledMock).toHaveBeenCalledWith(skill.path, true);
        expect(deleteUserSkillDirectoryMock).toHaveBeenCalledWith(skill.directory);
        expect(openUserSkillsRootMock).toHaveBeenCalledTimes(1);
        expect(openUserSkillDirectoryMock).toHaveBeenCalledWith(skill.directory);
    });
});

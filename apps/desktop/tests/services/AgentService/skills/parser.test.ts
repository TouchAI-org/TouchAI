import { describe, expect, it } from 'vitest';

import { parseSkillMarkdown } from '@/services/AgentService/skills';

describe('parseSkillMarkdown', () => {
    it('user parses required name and description frontmatter', () => {
        const parsed = parseSkillMarkdown(
            [
                '---',
                'name: code-quality-review',
                'description: Review code quality.',
                '---',
                '',
                '# Body',
            ].join('\n'),
            'C:/Users/demo/.agents/skills/code-quality-review/SKILL.md'
        );

        expect(parsed).toEqual({
            name: 'code-quality-review',
            description: 'Review code quality.',
            shortDescription: null,
            path: 'C:/Users/demo/.agents/skills/code-quality-review/SKILL.md',
            directory: 'C:/Users/demo/.agents/skills/code-quality-review',
            body: '# Body',
        });
    });

    it('user supports metadata.short-description', () => {
        const parsed = parseSkillMarkdown(
            [
                '---',
                'name: "ui-ux-pro-max"',
                "description: 'Long UI guidance.'",
                '# ignored comment',
                'metadata:',
                '  short-description: Short UI guidance',
                '  ignored-nested-key:',
                '    child: value',
                '---',
                '',
                'Use with care.',
            ].join('\n'),
            'C:/Users/demo/.agents/skills/ui-ux-pro-max/SKILL.md'
        );

        expect(parsed.shortDescription).toBe('Short UI guidance');
    });

    it('user returns an empty directory when the skill path has no separator', () => {
        const parsed = parseSkillMarkdown(
            ['---', 'name: demo', 'description: Demo skill.', '---', '', 'Body'].join('\n'),
            'SKILL.md'
        );

        expect(parsed.directory).toBe('');
    });

    it('user rejects missing frontmatter', () => {
        expect(() =>
            parseSkillMarkdown('# Missing frontmatter', 'C:/Users/demo/.agents/skills/bad/SKILL.md')
        ).toThrow('SKILL.md must start with YAML frontmatter');
    });

    it('user rejects unclosed frontmatter', () => {
        expect(() =>
            parseSkillMarkdown(
                ['---', 'name: bad-skill', 'description: Missing end'].join('\n'),
                'C:/Users/demo/.agents/skills/bad/SKILL.md'
            )
        ).toThrow('SKILL.md frontmatter is not closed');
    });

    it('user rejects missing required fields', () => {
        expect(() =>
            parseSkillMarkdown(
                ['---', 'name: bad-skill', '---', '', '# Body'].join('\n'),
                'C:/Users/demo/.agents/skills/bad/SKILL.md'
            )
        ).toThrow('description');
    });
});

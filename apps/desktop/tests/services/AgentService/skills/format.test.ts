import {
    flushObservability,
    initObservability,
    resetObservabilityForTests,
} from '@services/ObservabilityService';
import { getTauriInvokeCalls } from '@tests/utils/tauri';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { parseSkillMarkdown } from '@/services/AgentService/skills/parser';

afterEach(resetObservabilityForTests);

describe('given a standard skill with YAML frontmatter', () => {
    it('user sees a folded description when loading a multiline skill definition', () => {
        const skill = parseSkillMarkdown(
            '---\nname: summarize\ndescription: >-\n  Summarize documents\n  in three bullets.\nmetadata:\n  short-description: "Quick: summary"\n---\nBody',
            '/home/demo/.agents/skills/summarize/SKILL.md'
        );
        expect(skill.description).toBe('Summarize documents in three bullets.');
        expect(skill.shortDescription).toBe('Quick: summary');
        expect(skill.body).toBe('Body');
    });

    it('user sees invalid duplicate metadata rejected instead of silently overwritten', () => {
        expect(() =>
            parseSkillMarkdown(
                '---\nname: first\nname: second\ndescription: Test\n---',
                '/skills/demo/SKILL.md'
            )
        ).toThrow();
    });

    it('user cannot load a skill whose closing metadata delimiter has trailing text', () => {
        expect(() =>
            parseSkillMarkdown(
                '---\nname: summary\ndescription: Summary\n---private instructions',
                '/skills/summary/SKILL.md'
            )
        ).toThrow('SKILL.md frontmatter is not closed');
    });

    it('user sees a safe validation error when malformed YAML contains private content', () => {
        expect(() =>
            parseSkillMarkdown(
                '---\nname: summary\ndescription: [PRIVATE_METADATA_MARKER\n---',
                '/skills/summary/SKILL.md'
            )
        ).toThrow('Skill metadata is invalid YAML');
    });

    it('user keeps private metadata out of logs when malformed YAML also produces a warning', async () => {
        // The browser build sends YAML warnings to console instead of Node's warning sink.
        vi.spyOn(process, 'emitWarning').mockImplementation((warning) => console.warn(warning));
        initObservability();

        expect(() =>
            parseSkillMarkdown(
                '---\nname: summary\ndescription: Summary\nprivate: !custom PRIVATE_METADATA_MARKER\nbroken: [\n---',
                '/skills/summary/SKILL.md'
            )
        ).toThrow('Skill metadata is invalid YAML');
        await flushObservability();

        const logs = getTauriInvokeCalls('obs_ingest');
        expect(logs.length).toBeGreaterThan(0);
        expect(JSON.stringify(logs)).not.toContain('PRIVATE_METADATA_MARKER');
        expect(
            parseSkillMarkdown(
                '---\nname: summary\ndescription: Summary\n---\nBody',
                '/skills/summary/SKILL.md'
            ).body
        ).toBe('Body');
    });

    it('user loads Windows line endings and a byte order mark without changing the body', () => {
        expect(
            parseSkillMarkdown(
                '\ufeff---\r\nname: summary\r\ndescription: Summary\r\n---\r\nBody',
                '/skills/summary/SKILL.md'
            ).body
        ).toBe('Body');
    });
});

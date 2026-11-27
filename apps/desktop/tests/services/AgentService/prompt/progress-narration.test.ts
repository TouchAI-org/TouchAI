import { describe, expect, it } from 'vitest';

import { TOUCHAI_BUILTIN_SYSTEM_PROMPT } from '@/app/workflows/agent/instructions';

describe('user can follow multi-step work as it happens', () => {
    it('user is told what happens next before the assistant starts acting', () => {
        expect(TOUCHAI_BUILTIN_SYSTEM_PROMPT).toContain(
            'state what you are about to do in one short line before acting'
        );
    });

    it('user is not flooded with a running commentary on every step', () => {
        expect(TOUCHAI_BUILTIN_SYSTEM_PROMPT).toContain('do not narrate every step');
    });

    it('user hears from the assistant again when something changes or work stalls', () => {
        expect(TOUCHAI_BUILTIN_SYSTEM_PROMPT).toContain('find something notable');
        expect(TOUCHAI_BUILTIN_SYSTEM_PROMPT).toContain('change direction');
        expect(TOUCHAI_BUILTIN_SYSTEM_PROMPT).toContain('get blocked');
    });

    it('user is not left in silence during long stretches of work', () => {
        expect(TOUCHAI_BUILTIN_SYSTEM_PROMPT).toContain(
            'have gone four or five steps without an update'
        );
        expect(TOUCHAI_BUILTIN_SYSTEM_PROMPT).toContain(
            'Silence for long stretches is not acceptable'
        );
    });
});

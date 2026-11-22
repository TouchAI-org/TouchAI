import { describe, expect, it } from 'vitest';

import { TOUCHAI_BUILTIN_SYSTEM_PROMPT } from '@/app/workflows/agent/instructions';

describe('user reads web sources as inline links', () => {
    it('user sees the model told to cite the page title as an inline link', () => {
        expect(TOUCHAI_BUILTIN_SYSTEM_PROMPT).toContain('inline Markdown links');
        expect(TOUCHAI_BUILTIN_SYSTEM_PROMPT).toContain('link text is the page title');
    });

    it('user does not see numeric markers requested instead of readable titles', () => {
        expect(TOUCHAI_BUILTIN_SYSTEM_PROMPT).toContain(
            'do not replace the title with a numeric marker'
        );
        expect(TOUCHAI_BUILTIN_SYSTEM_PROMPT).not.toMatch(/\[来源\]/);
    });
});

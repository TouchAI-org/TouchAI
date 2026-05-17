import { describe, expect, it } from 'vitest';

import { BASH_TOOL_DESCRIPTION } from '@/services/BuiltInToolService/tools/bash/constants';

describe('BASH_TOOL_DESCRIPTION', () => {
    it('mentions rg (ripgrep) is available on PATH', () => {
        expect(BASH_TOOL_DESCRIPTION).toContain('rg');
        expect(BASH_TOOL_DESCRIPTION).toContain('ripgrep');
        expect(BASH_TOOL_DESCRIPTION).toContain('PATH');
    });

    it('instructs the model to use rg for content search', () => {
        expect(BASH_TOOL_DESCRIPTION).toContain('content/code search');
    });

    it('includes common rg usage examples', () => {
        expect(BASH_TOOL_DESCRIPTION).toContain('rg "pattern"');
        expect(BASH_TOOL_DESCRIPTION).toContain('-t ts');
    });

    it('discourages Select-String in favor of rg', () => {
        expect(BASH_TOOL_DESCRIPTION).toContain('ALWAYS use');
        expect(BASH_TOOL_DESCRIPTION).toContain('Select-String');
    });

    it('still describes the PowerShell shell environment', () => {
        expect(BASH_TOOL_DESCRIPTION).toContain('PowerShell');
        expect(BASH_TOOL_DESCRIPTION).toContain('powershell.exe');
    });
});

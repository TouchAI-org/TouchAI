import { describe, expect, it } from 'vitest';

import {
    BASH_TOOL_DESCRIPTION,
    BASH_TOOL_INPUT_SCHEMA,
    bashCommandContextSchema,
    bashToolConfigSchema,
    DEFAULT_BASH_TOOL_CONFIG,
} from '@/services/BuiltInToolService/tools/bash/constants';

describe('user runs shell commands with a documented tool contract', () => {
    it('user sees the tool description mention rg is available on PATH', () => {
        expect(BASH_TOOL_DESCRIPTION).toContain('rg');
        expect(BASH_TOOL_DESCRIPTION).toContain('ripgrep');
        expect(BASH_TOOL_DESCRIPTION).toContain('PATH');
    });

    it('user sees the model told to use rg for content search', () => {
        expect(BASH_TOOL_DESCRIPTION).toContain('content/code search');
    });

    it('user sees common rg usage examples in the tool description', () => {
        expect(BASH_TOOL_DESCRIPTION).toContain('rg "pattern"');
        expect(BASH_TOOL_DESCRIPTION).toContain('-t ts');
    });

    it('user sees Select-String discouraged in favor of rg', () => {
        expect(BASH_TOOL_DESCRIPTION).toContain('ALWAYS use');
        expect(BASH_TOOL_DESCRIPTION).toContain('Select-String');
    });

    it('user sees the PowerShell shell environment described', () => {
        expect(BASH_TOOL_DESCRIPTION).toContain('PowerShell');
        expect(BASH_TOOL_DESCRIPTION).toContain('powershell.exe');
    });
});

describe('user sees the shell tool defaults', () => {
    it('user sees output compaction off by default', () => {
        expect(DEFAULT_BASH_TOOL_CONFIG.compactOutput).toBe(false);
    });

    it('user sees the default config shape', () => {
        expect(DEFAULT_BASH_TOOL_CONFIG).toEqual({
            approvalMode: 'high_risk',
            defaultWorkingDirectory: '',
            allowedWorkingDirectories: [],
            // 与参考实现一致：前台命令默认 2 分钟上限。
            timeoutMs: 120000,
            maxOutputChars: 12000,
            compactOutput: false,
        });
    });
});

describe('user sees the shell tool input schema', () => {
    const properties = BASH_TOOL_INPUT_SCHEMA.properties as Record<string, unknown>;

    it('user sees raw output declared as an optional boolean', () => {
        const rawOutput = properties.rawOutput as Record<string, unknown>;
        expect(rawOutput).toBeDefined();
        expect(rawOutput.type).toBe('boolean');
        expect(rawOutput.default).toBe(false);
        expect(typeof rawOutput.description).toBe('string');
    });

    it('user sees command, reason, working directory, and raw output in the schema', () => {
        expect(properties).toHaveProperty('command');
        expect(properties).toHaveProperty('reason');
        expect(properties).toHaveProperty('workingDirectory');
        expect(properties).toHaveProperty('rawOutput');
    });
});

describe('user sees the shell tool config validated', () => {
    it('user sees output compaction turned on from config', () => {
        const result = bashToolConfigSchema.safeParse({ compactOutput: true });
        expect(result.success).toBe(true);
        if (result.success) {
            expect(result.data.compactOutput).toBe(true);
        }
    });

    it('user sees output compaction turned off from config', () => {
        const result = bashToolConfigSchema.safeParse({ compactOutput: false });
        expect(result.success).toBe(true);
        if (result.success) {
            expect(result.data.compactOutput).toBe(false);
        }
    });

    it('user sees output compaction off when the config omits it', () => {
        const result = bashToolConfigSchema.safeParse({});
        expect(result.success).toBe(true);
        if (result.success) {
            expect(result.data.compactOutput).toBe(false);
        }
    });

    it('user sees output compaction off when the config value has the wrong type', () => {
        const result = bashToolConfigSchema.safeParse({ compactOutput: 'yes' });
        expect(result.success).toBe(true);
        if (result.success) {
            expect(result.data.compactOutput).toBe(false);
        }
    });

    it('user sees other config fields preserved beside output compaction', () => {
        const result = bashToolConfigSchema.safeParse({
            compactOutput: true,
            approvalMode: 'always',
            timeoutMs: 30000,
        });
        expect(result.success).toBe(true);
        if (result.success) {
            expect(result.data.compactOutput).toBe(true);
            expect(result.data.approvalMode).toBe('always');
            expect(result.data.timeoutMs).toBe(30000);
        }
    });

    it('user sees 0 accepted as the no-timeout sentinel', () => {
        const result = bashToolConfigSchema.safeParse({ timeoutMs: 0 });
        expect(result.success).toBe(true);
        if (result.success) {
            expect(result.data.timeoutMs).toBe(0);
        }
    });

    it('user sees an out-of-range timeout fall back to the default', () => {
        const result = bashToolConfigSchema.safeParse({ timeoutMs: 120001 });
        expect(result.success).toBe(true);
        if (result.success) {
            expect(result.data.timeoutMs).toBe(DEFAULT_BASH_TOOL_CONFIG.timeoutMs);
        }
    });
});

describe('user sees the command context validated', () => {
    it('user sees raw output true accepted', () => {
        const result = bashCommandContextSchema.safeParse({
            command: 'git status',
            rawOutput: true,
        });
        expect(result.success).toBe(true);
        if (result.success) {
            expect(result.data.rawOutput).toBe(true);
        }
    });

    it('user sees raw output false accepted', () => {
        const result = bashCommandContextSchema.safeParse({
            command: 'git status',
            rawOutput: false,
        });
        expect(result.success).toBe(true);
        if (result.success) {
            expect(result.data.rawOutput).toBe(false);
        }
    });

    it('user sees a missing raw output accepted as optional', () => {
        const result = bashCommandContextSchema.safeParse({
            command: 'git status',
        });
        expect(result.success).toBe(true);
        if (result.success) {
            expect(result.data.rawOutput).toBeUndefined();
        }
    });

    it('user sees an empty command rejected', () => {
        const result = bashCommandContextSchema.safeParse({
            command: '',
        });
        expect(result.success).toBe(false);
    });

    it('user sees a missing command rejected', () => {
        const result = bashCommandContextSchema.safeParse({});
        expect(result.success).toBe(false);
    });
});

import { describe, expect, it } from 'vitest';

import {
    BASH_TOOL_DESCRIPTION,
    BASH_TOOL_INPUT_SCHEMA,
    bashCommandContextSchema,
    bashToolConfigSchema,
    DEFAULT_BASH_TOOL_CONFIG,
} from '@/services/BuiltInToolService/tools/bash/constants';

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

    it('directs file mutations to ApplyPatch by default', () => {
        expect(BASH_TOOL_DESCRIPTION).toContain('Use ApplyPatch');
        expect(BASH_TOOL_DESCRIPTION).toContain('allowFileMutation');
    });
});

describe('DEFAULT_BASH_TOOL_CONFIG', () => {
    it('has compactOutput defaulting to false', () => {
        expect(DEFAULT_BASH_TOOL_CONFIG.compactOutput).toBe(false);
    });

    it('has expected shape', () => {
        expect(DEFAULT_BASH_TOOL_CONFIG).toEqual({
            approvalMode: 'high_risk',
            defaultWorkingDirectory: '',
            allowedWorkingDirectories: [],
            timeoutMs: 15000,
            maxOutputChars: 12000,
            compactOutput: false,
        });
    });
});

describe('BASH_TOOL_INPUT_SCHEMA', () => {
    const properties = BASH_TOOL_INPUT_SCHEMA.properties as Record<string, unknown>;

    it('defines rawOutput as an optional boolean parameter', () => {
        const rawOutput = properties.rawOutput as Record<string, unknown>;
        expect(rawOutput).toBeDefined();
        expect(rawOutput.type).toBe('boolean');
        expect(rawOutput.default).toBe(false);
        expect(typeof rawOutput.description).toBe('string');
    });

    it('defines allowFileMutation as an optional boolean parameter', () => {
        const allowFileMutation = properties.allowFileMutation as Record<string, unknown>;
        expect(allowFileMutation).toBeDefined();
        expect(allowFileMutation.type).toBe('boolean');
        expect(allowFileMutation.default).toBe(false);
        expect(typeof allowFileMutation.description).toBe('string');
    });

    it('includes command, reason, workingDirectory, rawOutput, and allowFileMutation', () => {
        expect(properties).toHaveProperty('command');
        expect(properties).toHaveProperty('reason');
        expect(properties).toHaveProperty('workingDirectory');
        expect(properties).toHaveProperty('rawOutput');
        expect(properties).toHaveProperty('allowFileMutation');
    });
});

describe('bashToolConfigSchema', () => {
    it('parses compactOutput true from config JSON', () => {
        const result = bashToolConfigSchema.safeParse({ compactOutput: true });
        expect(result.success).toBe(true);
        if (result.success) {
            expect(result.data.compactOutput).toBe(true);
        }
    });

    it('parses compactOutput false from config JSON', () => {
        const result = bashToolConfigSchema.safeParse({ compactOutput: false });
        expect(result.success).toBe(true);
        if (result.success) {
            expect(result.data.compactOutput).toBe(false);
        }
    });

    it('defaults compactOutput to false when missing', () => {
        const result = bashToolConfigSchema.safeParse({});
        expect(result.success).toBe(true);
        if (result.success) {
            expect(result.data.compactOutput).toBe(false);
        }
    });

    it('defaults compactOutput to false when given invalid type', () => {
        const result = bashToolConfigSchema.safeParse({ compactOutput: 'yes' });
        expect(result.success).toBe(true);
        if (result.success) {
            expect(result.data.compactOutput).toBe(false);
        }
    });

    it('preserves other config fields alongside compactOutput', () => {
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
});

describe('bashCommandContextSchema', () => {
    it('accepts rawOutput true', () => {
        const result = bashCommandContextSchema.safeParse({
            command: 'git status',
            rawOutput: true,
        });
        expect(result.success).toBe(true);
        if (result.success) {
            expect(result.data.rawOutput).toBe(true);
        }
    });

    it('accepts rawOutput false', () => {
        const result = bashCommandContextSchema.safeParse({
            command: 'git status',
            rawOutput: false,
        });
        expect(result.success).toBe(true);
        if (result.success) {
            expect(result.data.rawOutput).toBe(false);
        }
    });

    it('accepts missing rawOutput as optional', () => {
        const result = bashCommandContextSchema.safeParse({
            command: 'git status',
        });
        expect(result.success).toBe(true);
        if (result.success) {
            expect(result.data.rawOutput).toBeUndefined();
        }
    });

    it('accepts allowFileMutation true', () => {
        const result = bashCommandContextSchema.safeParse({
            command: 'Set-Content file.txt value',
            allowFileMutation: true,
        });
        expect(result.success).toBe(true);
        if (result.success) {
            expect(result.data.allowFileMutation).toBe(true);
        }
    });

    it('accepts missing allowFileMutation as optional', () => {
        const result = bashCommandContextSchema.safeParse({
            command: 'git status',
        });
        expect(result.success).toBe(true);
        if (result.success) {
            expect(result.data.allowFileMutation).toBeUndefined();
        }
    });

    it('rejects empty command', () => {
        const result = bashCommandContextSchema.safeParse({
            command: '',
        });
        expect(result.success).toBe(false);
    });

    it('rejects missing command', () => {
        const result = bashCommandContextSchema.safeParse({});
        expect(result.success).toBe(false);
    });
});

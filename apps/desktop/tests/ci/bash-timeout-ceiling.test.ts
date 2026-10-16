import { readFile } from 'node:fs/promises';
import { join } from 'node:path';

import { describe, expect, it } from 'vitest';

import { BASH_TOOL_TIMEOUT_MAX_MS } from '@/services/BuiltInToolService/tools/bash/constants';

const BASH_EXECUTOR_PATH = join(
    process.cwd(),
    'src-tauri',
    'src',
    'core',
    'built_in_tools',
    'bash.rs'
);

describe('Bash adaptive timeout ceiling', () => {
    // This is a source-level drift guard: it keeps the TypeScript ceiling and the
    // Rust hard limit in lockstep so a model request is never silently truncated.
    // It does not exercise the Rust execution path (the existing
    // `resolve_timeout_ms_clamps_to_max` unit test covers the clamp itself).
    it('keeps the TypeScript ceiling equal to the Rust MAX_TIMEOUT_MS constant', async () => {
        const source = await readFile(BASH_EXECUTOR_PATH, 'utf8');
        const match = source.match(/const\s+MAX_TIMEOUT_MS\s*:\s*u64\s*=\s*([0-9_]+)\s*;/);

        expect(match, 'MAX_TIMEOUT_MS must be declared in bash.rs').not.toBeNull();

        const rustMaxMs = Number(match![1]!.replace(/_/g, ''));
        expect(rustMaxMs).toBe(BASH_TOOL_TIMEOUT_MAX_MS);
    });
});

// Copyright (c) 2026. Qian Cheng. Licensed under GPL v3

import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

import { classifyError, OBSERVABILITY_ERROR_CODES } from '@services/ObservabilityService/errors';
import { describe, expect, it } from 'vitest';

describe('user gets stable error codes across the frontend and Rust', () => {
    it('user gets the same error vocabulary on both sides of IPC', () => {
        const rustSource = readFileSync(
            resolve(process.cwd(), 'src-tauri/src/core/observability/error_code.rs'),
            'utf8'
        );
        const rustCodes = [...rustSource.matchAll(/#\[serde\(rename = "([^"]+)"\)\]/g)].map(
            (match) => match[1]
        );

        expect(rustCodes).toEqual([...OBSERVABILITY_ERROR_CODES]);
    });

    it('user gets provider auth failures classified for a stable log field', () => {
        expect(classifyError({ code: 'INVALID_API_KEY' })).toBe('provider.auth');
        expect(classifyError(new Error('request timed out'))).toBe('network.timeout');
    });
});

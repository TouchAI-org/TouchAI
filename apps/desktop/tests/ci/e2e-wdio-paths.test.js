import path from 'node:path';

import { describe, expect, it } from 'vitest';

import {
    resolveE2eAppBinaryPath,
    resolveE2eCargoProfile,
    resolveTauriBuildArgs,
} from '../../e2e-tests/wdio.paths.js';

describe('E2E WDIO build paths', () => {
    it('uses the Tauri debug output when no E2E cargo profile is configured', () => {
        const env = {};

        expect(resolveE2eCargoProfile(env)).toBeUndefined();
        expect(resolveTauriBuildArgs(env)).toEqual(['tauri', 'build', '--debug', '--no-bundle']);
        expect(resolveE2eAppBinaryPath('D:\\target\\e2e', 'win32', env)).toBe(
            path.resolve('D:\\target\\e2e', 'debug', 'TouchAI.exe')
        );
    });

    it('uses the configured E2E cargo profile for build args and binary path', () => {
        const env = {
            TOUCHAI_E2E_CARGO_PROFILE: 'ci-check',
        };

        expect(resolveE2eCargoProfile(env)).toBe('ci-check');
        expect(resolveTauriBuildArgs(env)).toEqual([
            'tauri',
            'build',
            '--debug',
            '--no-bundle',
            '--',
            '--profile',
            'ci-check',
        ]);
        expect(resolveE2eAppBinaryPath('D:\\target\\e2e', 'win32', env)).toBe(
            path.resolve('D:\\target\\e2e', 'ci-check', 'TouchAI.exe')
        );
    });
});

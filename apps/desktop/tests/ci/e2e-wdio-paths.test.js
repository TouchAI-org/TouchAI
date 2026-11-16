import path from 'node:path';

import { describe, expect, it } from 'vitest';

import { APP_PRODUCT_CONFIG } from '@/config/product';

import {
    resolveE2eAppBinaryPath,
    resolveE2eCargoProfile,
    resolveE2eRuntimeDirectory,
    resolveTauriBuildArgs,
} from '../../e2e-tests/wdio.paths.js';

describe('user starts desktop tests with a built application', () => {
    it('user gets the debug application when starting tests without a custom build profile', () => {
        const env = {};

        expect(resolveE2eCargoProfile(env)).toBeUndefined();
        expect(resolveTauriBuildArgs(env)).toEqual(['tauri', 'build', '--debug', '--no-bundle']);
        expect(resolveE2eAppBinaryPath('D:\\target\\e2e', 'win32', env)).toBe(
            path.resolve('D:\\target\\e2e', 'debug', APP_PRODUCT_CONFIG.packaging.mainExe)
        );
    });

    it('user gets the matching application when choosing a custom build profile', () => {
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
            path.resolve('D:\\target\\e2e', 'ci-check', APP_PRODUCT_CONFIG.packaging.mainExe)
        );
    });
});

describe('user runs desktop regressions with isolated data', () => {
    it('user given no runtime override when starting tests then uses the dedicated workspace runtime', () => {
        expect(resolveE2eRuntimeDirectory('/checkout', {})).toBe(
            path.resolve('/checkout', '.e2e-runtime')
        );
    });

    it('user given an external runtime directory when starting tests then keeps output outside the checkout', () => {
        const directory = path.resolve('/external/queue-e2e');

        expect(
            resolveE2eRuntimeDirectory('/checkout', { TOUCHAI_E2E_RUNTIME_ROOT: directory })
        ).toBe(directory);
    });

    it('user given a relative runtime override when starting tests then resolves it from the checkout', () => {
        expect(
            resolveE2eRuntimeDirectory('/checkout', { TOUCHAI_E2E_RUNTIME_ROOT: '../queue-e2e' })
        ).toBe(path.resolve('/checkout', '../queue-e2e'));
    });

    it.each(['/', '/checkout'])(
        'user given an unsafe runtime root %s when starting tests then cannot clear that directory',
        (directory) => {
            expect(() =>
                resolveE2eRuntimeDirectory('/checkout', { TOUCHAI_E2E_RUNTIME_ROOT: directory })
            ).toThrow('dedicated directory');
        }
    );
});

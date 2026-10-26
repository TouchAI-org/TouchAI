import { defineConfig, devices } from '@playwright/test';

/**
 * Component-level visual regression for Storybook.
 *
 * This is the second layer, and it exists because the two layers answer different
 * questions:
 *
 * - The WebdriverIO suite (`test:e2e`) renders the real Tauri app and proves that
 *   the assembled interface still looks right. It can only reach screens it can
 *   navigate to, and each run costs a Rust build.
 * - This suite renders one component at a time in a browser, so it covers the
 *   states a screen never shows all at once: every button variant, a switch in
 *   each size and state, an empty and a populated chart.
 *
 * Both use the same `tailwind.css` and the same verified product font, so a token
 * change fails in both places rather than only in the one a contributor ran.
 *
 * Storybook is started by Playwright itself (`webServer`), so `pnpm test:visual:components`
 * is a single command and CI needs no extra step.
 */
export default defineConfig({
    testDir: './tests/visual',
    // `.visual.ts` rather than `.spec.ts`: these files must not be picked up by
    // Vitest, which owns everything under `tests/**/*.test.ts`, and the name states
    // which layer a failure came from.
    testMatch: '**/*.visual.ts',
    // Baselines live beside the specs, in Storybook's own snapshot convention.
    snapshotDir: './tests/visual/__snapshots__',
    snapshotPathTemplate: '{snapshotDir}/{arg}{ext}',
    fullyParallel: true,
    forbidOnly: Boolean(process.env.CI),
    retries: process.env.CI ? 1 : 0,
    workers: process.env.CI ? 2 : undefined,
    // `github` annotates failures on the PR, `list` keeps the log readable, and the
    // JSON file is what `scripts/ci/visual-summary.mjs` turns into the job summary.
    // Without it the reviewer learns that something moved but not what, and the
    // images die with the runner.
    reporter: process.env.CI
        ? [['github'], ['list'], ['json', { outputFile: 'test-results/results.json' }]]
        : 'list',
    // A component baseline must not depend on the machine's scaling. Playwright
    // renders headless Chromium at deviceScaleFactor 1 on every platform, which is
    // also why this layer is less tolerant than the end-to-end one.
    expect: {
        toHaveScreenshot: {
            maxDiffPixelRatio: 0.001,
            animations: 'disabled',
        },
    },
    use: {
        baseURL: 'http://127.0.0.1:6006',
        trace: 'retain-on-failure',
        deviceScaleFactor: 1,
    },
    projects: [
        {
            name: 'chromium',
            use: { ...devices['Desktop Chrome'], deviceScaleFactor: 1, headless: true },
        },
    ],
    webServer: {
        command: 'pnpm exec storybook dev --ci --port 6006 --no-open',
        url: 'http://127.0.0.1:6006/index.json',
        reuseExistingServer: !process.env.CI,
        timeout: 180_000,
        stdout: 'ignore',
        stderr: 'pipe',
    },
});

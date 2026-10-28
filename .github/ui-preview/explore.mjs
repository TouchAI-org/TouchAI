/**
 * Builds the facts the planner needs from the real build: which test ids exist,
 * which settings sections render, whether the window overflows, and whether both
 * locales declare the same keys.
 *
 * Runs pull-request code, so it receives no repository secret and no write token.
 */

import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';

import {
    captureScreenshot,
    ensureDir,
    paintDesktop,
    raiseWindow,
    windowForSurface,
} from './lib/capture.mjs';
import { checkLocaleParity } from './lib/i18n.mjs';
import {
    boot,
    collectOutline,
    collectSettingsOutline,
    collectTestIds,
    ensureOverlay,
    mainWindowHandle,
    measureOverflow,
    openSettings,
    switchToSurface,
    waitForBridge,
} from './lib/runtime.mjs';

function env(name, fallback = '') {
    return process.env[name] ?? fallback;
}

function changedFiles() {
    const listed = env('UI_PREVIEW_FILES')
        .split('\n')
        .map((line) => line.trim())
        .filter(Boolean);

    if (listed.length > 0) {
        return listed;
    }

    const base = env('UI_PREVIEW_BASE_SHA');

    if (!base) {
        return [];
    }

    const result = spawnSync('git', ['diff', '--name-only', `${base}...HEAD`], {
        encoding: 'utf8',
    });

    if (result.status !== 0) {
        console.log(`could not list changed files: ${result.stderr.trim()}`);
        return [];
    }

    return result.stdout
        .split('\n')
        .map((line) => line.trim())
        .filter(Boolean);
}

async function main() {
    const application = env('UI_PREVIEW_APP_BINARY');
    const outDir = ensureDir(env('UI_PREVIEW_OUT', 'ui-preview-out'));
    const sha = env('UI_PREVIEW_SHA');
    const display = env('DISPLAY', ':99');
    const files = changedFiles();

    if (!application || !fs.existsSync(application)) {
        throw new Error(`UI_PREVIEW_APP_BINARY does not exist: ${application}`);
    }

    paintDesktop(display);

    const runtime = await boot({ application });
    const { session } = runtime;

    try {
        await waitForBridge(session);
        await mainWindowHandle(session);
        await ensureOverlay(session);

        const searchTestIds = await collectTestIds(session);
        const searchOutline = await collectOutline(session, 40);
        const searchOverflow = await measureOverflow(session);

        const settingsElements = {};
        const { settings } = await openSettings(session);
        const settingsOutline = await collectSettingsOutline(session, settingsElements);
        await session.switchTo(settings);
        const settingsOverflow = await measureOverflow(session);

        await switchToSurface(session, 'search');
        const geometry = windowForSurface(display, 'search');
        const baselineFile = path.join(outDir, 'baseline-search.png');

        if (geometry) {
            raiseWindow(display, geometry.id);
            captureScreenshot({ display, file: baselineFile, geometry });
        }

        const facts = {
            version: 1,
            sha,
            files,
            testIds: {
                search: [...new Set([...searchTestIds, ...settingsOutline.testIds])].sort(),
                settings: settingsOutline.testIds,
            },
            settingsSections: settingsOutline.sections,
            settingsNavIds: settingsOutline.navIds,
            elements: {
                search: searchOutline,
                settings: settingsElements,
            },
            overflow: {
                search: searchOverflow,
                settings: settingsOverflow,
            },
            i18nParity: checkLocaleParity(path.join(process.cwd(), 'apps/desktop/src/i18n')),
            baseline: geometry ? path.basename(baselineFile) : null,
        };

        fs.writeFileSync(path.join(outDir, 'facts.json'), `${JSON.stringify(facts, null, 2)}\n`);
        console.log(
            `outline: ${facts.testIds.settings.length} settings test ids, ${facts.settingsSections.length} sections`
        );
    } finally {
        await runtime.close();
    }
}

main().catch((error) => {
    console.error(error.stack ?? error.message);
    process.exit(1);
});

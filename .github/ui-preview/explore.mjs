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
import { parseDisplaySize } from './lib/native-capture.mjs';
import { captureMode, detectPlatform, isUsableDisplay, platformLabel } from './lib/platform.mjs';
import { resolveCaptureProfile, stageLabel } from './lib/profile.mjs';
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

function sleep(ms) {
    return new Promise((resolve) => setTimeout(resolve, ms));
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
    const platform = detectPlatform();
    const profile = resolveCaptureProfile(process.env);
    const displaySize = parseDisplaySize(process.env, platform, profile);
    const files = changedFiles();

    if (!application || !fs.existsSync(application)) {
        throw new Error(`UI_PREVIEW_APP_BINARY does not exist: ${application}`);
    }

    if (
        !isUsableDisplay(
            displaySize.width,
            displaySize.height,
            profile.physical.width,
            profile.physical.height
        )
    ) {
        throw new Error(
            `${platformLabel(platform)} exposes ${displaySize.width}x${displaySize.height}; the preview needs at least ${profile.physical.width}x${profile.physical.height}`
        );
    }

    if (platform === 'linux') {
        paintDesktop(display);
    }

    const runtime = await boot({ application, platform });
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
        const baselineFile = path.join(outDir, 'baseline-search.png');
        let baseline = false;
        let baselineError = null;

        try {
            if (platform === 'linux') {
                const geometry = windowForSurface(display, 'search', profile.scale);

                if (geometry) {
                    raiseWindow(display, geometry.id);
                    captureScreenshot({ display, file: baselineFile, geometry });
                    baseline = fs.existsSync(baselineFile);
                }
            } else {
                await session.focusWindow();
                await sleep(500);
                const base64 = await session.screenshot();
                fs.writeFileSync(baselineFile, Buffer.from(base64, 'base64'));
                baseline = fs.existsSync(baselineFile);
            }
        } catch (error) {
            baselineError = error.message;
            fs.rmSync(baselineFile, { force: true });
            console.log(`baseline screenshot skipped: ${baselineError}`);
        }

        const facts = {
            version: 1,
            sha,
            platform,
            captureMode: captureMode(platform),
            display: displaySize,
            stage: profile.stage,
            scale: profile.scale,
            physicalStage: profile.physical,
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
            baseline: baseline ? path.basename(baselineFile) : null,
            baselineError,
        };

        fs.writeFileSync(path.join(outDir, 'facts.json'), `${JSON.stringify(facts, null, 2)}\n`);
        console.log(
            `outline: ${facts.testIds.settings.length} settings test ids, ${facts.settingsSections.length} sections, ${stageLabel(profile)}`
        );
    } finally {
        await runtime.close();
    }
}

main().catch((error) => {
    console.error(error.stack ?? error.message);
    process.exit(1);
});

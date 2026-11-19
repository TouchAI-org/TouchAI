import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFile, writeFile } from 'node:fs/promises';

import { getAgentFixture } from '../support/agent-fixture.js';
import {
    clearHistory,
    createDataManagementFixture,
    expectDataStatistics,
    openDataManagementSection,
    readDataStatistics,
    readImportNotice,
    requestDataManagement,
} from '../support/data-management.js';
import {
    callE2eBridge,
    closeSettingsWindow,
    SETTINGS_WINDOW_DEFAULT_SIZE,
    switchToWindowContaining,
    switchToWindowWithE2eBridge,
    useInterfaceLanguage,
    waitForE2eBridge,
    waitForTestIdDisplayed,
} from '../support/desktop.js';

async function expectSuccessfulRequest(command) {
    const reply = await requestDataManagement(command);
    assert.equal(reply.ok, true, `${command.operation} failed: ${reply.code ?? 'missing result'}`);
    assert.equal(reply.result, null, 'A completed data mutation must be acknowledged.');
}

async function backupDigest(backupPath) {
    const bytes = await readFile(backupPath);
    assert.equal(bytes.subarray(0, 16).toString('utf8'), 'SQLite format 3\0');
    return createHash('sha256').update(bytes).digest('hex');
}

describe('user manages independently saved history in Settings with main running', () => {
    // Mocha hooks fail the run; WebdriverIO afterSession errors only log.
    after(() => getAgentFixture().assertHealthy());

    let database;
    let scenario;
    let mainWindowHandle;
    let settingsWindowHandle;
    let previousScriptTimeout;

    before(async () => {
        database = await getAgentFixture();
        await waitForE2eBridge();
        await useInterfaceLanguage();
        mainWindowHandle = await browser.getWindowHandle();
        previousScriptTimeout = (await browser.getTimeouts()).script;
        await browser.setTimeout({ script: 75_000 });
        await callE2eBridge('openSettingsWindow');
        settingsWindowHandle = await switchToWindowContaining('/settings');
        await waitForTestIdDisplayed('settings-view');
        await browser.setWindowSize(...SETTINGS_WINDOW_DEFAULT_SIZE);
        await browser.execute(async () => {
            await window.__TAURI_INTERNALS__.invoke('plugin:window|set_focus', {
                label: 'settings',
            });
        });
        await browser.waitUntil(() => browser.execute(() => document.hasFocus()), {
            timeoutMsg: 'Settings must receive native focus before data management interactions.',
        });
    });

    beforeEach(async () => {
        scenario = await createDataManagementFixture(database);
        await openDataManagementSection();
        await expectDataStatistics(await readDataStatistics(database));
    });

    afterEach(async () => {
        await scenario?.dispose();
        scenario = undefined;
    });

    after(async () => {
        if (settingsWindowHandle) {
            await browser.switchToWindow(settingsWindowHandle);
            await closeSettingsWindow();
        }
        if (mainWindowHandle) await switchToWindowWithE2eBridge(mainWindowHandle);
        if (previousScriptTimeout !== undefined) {
            await browser.setTimeout({ script: previousScriptTimeout });
        }
    });

    it('user sees persisted session, message and turn counts when opening data management', async () => {
        const counts = await readDataStatistics(database);
        assert.ok(counts.sessions >= 2 && counts.messages >= 3 && counts.sessionTurns >= 1);
        await expectDataStatistics(counts);
        assert.equal(
            await browser.execute(() => window.__TAURI_INTERNALS__.metadata.currentWindow.label),
            'settings'
        );
    });

    it('user keeps history and unrelated settings when cancelling a clear request', async () => {
        const history = await scenario.history();
        const unrelated = await scenario.unrelated();
        const counts = await readDataStatistics(database);
        await clearHistory('messages', false);
        await expectDataStatistics(counts);
        assert.deepEqual(await scenario.history(), history);
        assert.deepEqual(await scenario.unrelated(), unrelated);
        assert.deepEqual(await readDataStatistics(database), counts);
    });

    it('user removes messages while retaining sessions, turns and settings when confirming message cleanup', async () => {
        const history = await scenario.history();
        const unrelated = await scenario.unrelated();
        const counts = { ...(await readDataStatistics(database)), messages: 0 };
        await clearHistory('messages');
        await expectDataStatistics(counts);
        assert.deepEqual(await readDataStatistics(database), counts);
        const remaining = await scenario.history();
        assert.deepEqual(remaining.sessions, history.sessions);
        assert.deepEqual(remaining.messages, []);
        assert.deepEqual(
            remaining.turns.map((turn) => ({ ...turn })),
            history.turns.map((turn) => ({ ...turn, prompt_content: null, response_content: null }))
        );
        const [parts] = await database.query('SELECT count(*) AS count FROM message_parts');
        assert.equal(
            Number(parts.count),
            0,
            'Message contents must be deleted with their messages.'
        );
        assert.deepEqual(await scenario.unrelated(), unrelated);
        assert.deepEqual(await database.query('PRAGMA foreign_key_check'), []);
        assert.equal(
            await $('[data-settings-search-target="data-clear-messages"] button').isEnabled(),
            false
        );
    });

    it('user removes conversation records while retaining messages and settings when confirming record cleanup', async () => {
        const history = await scenario.history();
        const unrelated = await scenario.unrelated();
        const counts = { ...(await readDataStatistics(database)), sessionTurns: 0 };
        await clearHistory('sessionTurns');
        await expectDataStatistics(counts);
        assert.deepEqual(await readDataStatistics(database), counts);
        assert.deepEqual(await scenario.history(), { ...history, turns: [] });
        assert.deepEqual(await scenario.unrelated(), unrelated);
        assert.deepEqual(await database.query('PRAGMA foreign_key_check'), []);
        assert.equal(
            await $('[data-settings-search-target="data-clear-turns"] button').isEnabled(),
            false
        );
    });

    for (const [mode, description] of [
        ['chat_only', 'conversation-only import and preserves newer settings'],
        ['full', 'full import and restores exported settings'],
    ]) {
        it(`user restores cleared history from an exported backup when choosing ${description}`, async () => {
            const history = await scenario.history();
            const unrelated = await scenario.unrelated();
            const counts = await readDataStatistics(database);
            await expectSuccessfulRequest({ operation: 'export', targetPath: scenario.backupPath });
            const exportedDigest = await backupDigest(scenario.backupPath);

            await clearHistory('sessionTurns');
            await expectDataStatistics({ ...counts, sessionTurns: 0 });
            await clearHistory('sessions');
            await expectDataStatistics({ sessions: 0, messages: 0, sessionTurns: 0 });
            assert.deepEqual(await scenario.history(), { sessions: [], messages: [], turns: [] });
            await database.execute(
                'UPDATE settings SET value = ? WHERE key = ?',
                'newer-value',
                scenario.settingKey
            );

            await expectSuccessfulRequest({
                operation: 'import',
                sourcePath: scenario.backupPath,
                mode,
            });
            assert.deepEqual(
                await scenario.history(),
                history,
                'Import must restore content and turn message links.'
            );
            const restored = await scenario.unrelated();
            assert.deepEqual(restored.providers, unrelated.providers);
            assert.deepEqual(restored.models, unrelated.models);
            assert.equal(
                restored.settings[0]?.value,
                mode === 'full' ? 'exported-value' : 'newer-value'
            );
            assert.equal(
                await readImportNotice(database),
                JSON.stringify({ type: 'import-success', version: 1, importMode: mode })
            );
            assert.deepEqual(await database.query('PRAGMA foreign_key_check'), []);
            assert.equal(
                await backupDigest(scenario.backupPath),
                exportedDigest,
                'Import must preserve its source backup.'
            );
            assert.deepEqual(await readDataStatistics(database), counts);
            await openDataManagementSection();
            await expectDataStatistics(counts);
        });
    }

    it('user keeps saved data after importing a corrupt backup and can explicitly import a valid backup afterward', async () => {
        const history = await scenario.history();
        const unrelated = await scenario.unrelated();
        const counts = await readDataStatistics(database);
        const previousNotice = await readImportNotice(database);
        await writeFile(scenario.corruptPath, 'RFC710 deliberately invalid SQLite backup\n', {
            flag: 'wx',
        });
        const reply = await requestDataManagement({
            operation: 'import',
            sourcePath: scenario.corruptPath,
            mode: 'full',
        });
        assert.equal(reply.ok, false, 'A corrupt backup must never be reported as imported.');
        assert.equal(reply.code, 'DATA_MANAGEMENT_UNCONFIRMED');
        assert.deepEqual(Object.keys(reply).sort(), ['code', 'ok', 'requestId']);
        assert.deepEqual(await scenario.history(), history);
        assert.deepEqual(await scenario.unrelated(), unrelated);
        assert.equal(await readImportNotice(database), previousNotice);
        assert.deepEqual(await readDataStatistics(database), counts);
        await openDataManagementSection();
        await expectDataStatistics(counts);

        await expectSuccessfulRequest({ operation: 'export', targetPath: scenario.backupPath });
        await backupDigest(scenario.backupPath);
        await expectSuccessfulRequest({
            operation: 'import',
            sourcePath: scenario.backupPath,
            mode: 'chat_only',
        });
        assert.deepEqual(await scenario.history(), history);
        assert.deepEqual(await scenario.unrelated(), unrelated);
        assert.equal(
            await readImportNotice(database),
            JSON.stringify({ type: 'import-success', version: 1, importMode: 'chat_only' })
        );
        assert.deepEqual(await database.query('PRAGMA foreign_key_check'), []);
        assert.deepEqual(await readDataStatistics(database), counts);
        await openDataManagementSection();
        await expectDataStatistics(counts);
    });
});

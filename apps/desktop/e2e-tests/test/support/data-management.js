import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { mkdtemp, rm } from 'node:fs/promises';
import path from 'node:path';

import { waitForTestIdDisplayed } from './desktop.js';

const HISTORY_SELECTORS = {
    sessions: 'data-clear-sessions',
    messages: 'data-clear-messages',
    sessionTurns: 'data-clear-turns',
};

export async function openDataManagementSection() {
    await (await waitForTestIdDisplayed('settings-nav-general')).click();
    await waitForTestIdDisplayed('settings-general-section');
    await (await waitForTestIdDisplayed('settings-nav-data-management')).click();
    await $('[data-settings-search-target="data-stats"]').waitForDisplayed();
}

export async function expectDataStatistics(expected) {
    let observed;
    await browser.waitUntil(
        async () => {
            observed = await browser.execute(() => {
                const stats = document.querySelector('[data-settings-search-target="data-stats"]');
                return stats?.innerText?.replace(/\s+/g, ' ').trim() ?? '';
            });
            return (
                observed ===
                `${expected.sessions} Conversation sessions ${expected.messages} Total messages ${expected.sessionTurns} Conversation turns`
            );
        },
        {
            timeoutMsg: `Settings did not display the persisted statistics ${JSON.stringify(expected)}.`,
        }
    );
    assert.ok(observed, 'Settings must display history statistics.');
}

export async function clearHistory(category, confirm = true) {
    assert.ok(Object.hasOwn(HISTORY_SELECTORS, category), 'Choose a known history category.');
    const button = await $(`[data-settings-search-target="${HISTORY_SELECTORS[category]}"] button`);
    await button.scrollIntoView();
    await button.waitForEnabled();
    await button.click();
    const dialog = await $('[role="alertdialog"]');
    await dialog.waitForDisplayed();
    await dialog.$(`button=${confirm ? 'Confirm' : 'Cancel'}`).click();
    await dialog.waitForDisplayed({ reverse: true });
}

export async function requestDataManagement(command) {
    return browser.execute(async (operation) => {
        const internals = window.__TAURI_INTERNALS__;
        if (internals?.metadata?.currentWindow?.label !== 'settings') {
            throw new Error('Data management requests must originate in the Settings window.');
        }
        const requestId = crypto.randomUUID();
        const event = 'data-management:reply';
        let settle;
        const completion = new Promise((resolve) => {
            settle = resolve;
        });
        const callbackId = internals.transformCallback(({ payload }) => {
            if (payload?.requestId === requestId) settle(payload);
        });
        let eventId;
        let timer;
        try {
            eventId = await internals.invoke('plugin:event|listen', {
                event,
                target: { kind: 'Window', label: 'settings' },
                handler: callbackId,
            });
            timer = setTimeout(() => settle(null), 65_000);
            await internals.invoke('plugin:event|emit_to', {
                target: { kind: 'AnyLabel', label: 'main' },
                event: 'data-management:request',
                payload: {
                    requestId,
                    createdAt: Date.now(),
                    from: 'settings',
                    command: operation,
                },
            });
            const reply = await completion;
            if (reply === null) {
                throw new Error('Main did not confirm the data management request within 65s.');
            }
            return reply;
        } finally {
            clearTimeout(timer);
            try {
                if (eventId !== undefined) {
                    window.__TAURI_EVENT_PLUGIN_INTERNALS__.unregisterListener(event, eventId);
                    await internals.invoke('plugin:event|unlisten', { event, eventId });
                }
            } finally {
                internals.unregisterCallback(callbackId);
            }
        }
    }, command);
}

export async function readDataStatistics(database) {
    const [counts] = await database.query(`
        SELECT (SELECT count(*) FROM sessions) AS sessions,
               (SELECT count(*) FROM messages) AS messages,
               (SELECT count(*) FROM session_turns) AS sessionTurns
    `);
    return {
        sessions: Number(counts.sessions),
        messages: Number(counts.messages),
        sessionTurns: Number(counts.sessionTurns),
    };
}

export async function readImportNotice(database) {
    const rows = await database.query(
        "SELECT value FROM touchai_meta WHERE key = 'import_success'"
    );
    return rows[0]?.value ?? null;
}

export async function createDataManagementFixture(database) {
    assert.equal(typeof database.query, 'function');
    assert.equal(typeof database.execute, 'function');
    const relativeDatabase = path.relative(database.appRoot, database.databasePath);
    assert.ok(
        relativeDatabase &&
            relativeDatabase !== '..' &&
            !relativeDatabase.startsWith(`..${path.sep}`) &&
            !path.isAbsolute(relativeDatabase),
        'Data management fixtures must use the database inside the isolated E2E app root.'
    );
    const [identity] = await database.query("SELECT value FROM touchai_meta WHERE key = 'app_id'");
    assert.equal(identity?.value, 'touchai', 'The app must initialize the production database.');

    const token = randomUUID();
    const providerName = `Data management ${token}`;
    const modelKey = `data-management-${token}`;
    const sessionKeys = [`${token}-conversation`, `${token}-unrelated`];
    const taskKey = `${token}-completed-turn`;
    const settingKey = `e2e_data_management_${token}`;
    const previousNotice = await readImportNotice(database);
    const directory = await mkdtemp(path.join(database.appRoot, 'data-management-'));

    async function dispose() {
        try {
            await database.execute(
                'DELETE FROM session_turn_attempts WHERE turn_id IN (SELECT id FROM session_turns WHERE task_id = ?)',
                taskKey
            );
            await database.execute('DELETE FROM session_turns WHERE task_id = ?', taskKey);
            await database.execute(
                `DELETE FROM message_parts WHERE message_id IN (
                    SELECT messages.id FROM messages JOIN sessions ON sessions.id = messages.session_id
                    WHERE sessions.session_id IN (?, ?)
                )`,
                ...sessionKeys
            );
            await database.execute(
                'DELETE FROM messages WHERE session_id IN (SELECT id FROM sessions WHERE session_id IN (?, ?))',
                ...sessionKeys
            );
            await database.execute(
                'DELETE FROM sessions WHERE session_id IN (?, ?)',
                ...sessionKeys
            );
            await database.execute(
                'DELETE FROM models WHERE provider_id IN (SELECT id FROM providers WHERE name = ?)',
                providerName
            );
            await database.execute('DELETE FROM providers WHERE name = ?', providerName);
            await database.execute('DELETE FROM settings WHERE key = ?', settingKey);
            if (previousNotice === null) {
                await database.execute("DELETE FROM touchai_meta WHERE key = 'import_success'");
            } else {
                await database.execute(
                    `INSERT INTO touchai_meta (key, value) VALUES ('import_success', ?)
                     ON CONFLICT(key) DO UPDATE SET value = excluded.value`,
                    previousNotice
                );
            }
        } finally {
            await rm(directory, { recursive: true, force: true });
        }
    }

    try {
        await database.execute(
            `INSERT INTO providers (name, driver, api_endpoint, logo, enabled)
             VALUES (?, 'openai-compatible', 'http://127.0.0.1:1/v1', '', 0)`,
            providerName
        );
        const [provider] = await database.query(
            'SELECT id FROM providers WHERE name = ?',
            providerName
        );
        await database.execute(
            'INSERT INTO models (provider_id, name, model_id) VALUES (?, ?, ?)',
            provider.id,
            modelKey,
            modelKey
        );
        const [model] = await database.query(
            'SELECT id FROM models WHERE provider_id = ? AND model_id = ?',
            provider.id,
            modelKey
        );
        const messageIds = [];
        const sessionIds = [];
        for (const [index, sessionKey] of sessionKeys.entries()) {
            await database.execute(
                `INSERT INTO sessions (session_id, title, model, provider_id, message_count)
                 VALUES (?, ?, ?, ?, ?)`,
                sessionKey,
                index === 0 ? 'Backup conversation' : 'Unrelated saved conversation',
                modelKey,
                provider.id,
                index === 0 ? 2 : 1
            );
            const [session] = await database.query(
                'SELECT id FROM sessions WHERE session_id = ?',
                sessionKey
            );
            sessionIds.push(session.id);
            const roles = index === 0 ? ['user', 'assistant'] : ['user'];
            for (const role of roles) {
                await database.execute(
                    'INSERT INTO messages (session_id, role) VALUES (?, ?)',
                    session.id,
                    role
                );
                const [message] = await database.query(
                    'SELECT id FROM messages WHERE session_id = ? AND role = ?',
                    session.id,
                    role
                );
                messageIds.push(message.id);
                await database.execute(
                    `INSERT INTO message_parts (message_id, type, content, sort_order)
                     VALUES (?, 'text', ?, 0)`,
                    message.id,
                    `${sessionKey} ${role} saved content`
                );
            }
        }
        const promptSnapshot = JSON.stringify({
            id: taskKey,
            createdAt: '2026-01-01T00:00:00.000Z',
            executionMode: 'foreground',
            modelLanguageContext: { locale: 'en-US', label: 'English' },
            fragments: [],
            systemPrompt: '',
            userPrompt: `${sessionKeys[0]} user saved content`,
            attachments: [],
        });
        await database.execute(
            `INSERT INTO session_turns (
                session_id, model_id, task_id, prompt_snapshot_json,
                prompt_message_id, response_message_id, status
             ) VALUES (?, ?, ?, ?, ?, ?, 'completed')`,
            sessionIds[0],
            model.id,
            taskKey,
            promptSnapshot,
            messageIds[0],
            messageIds[1]
        );
        await database.execute(
            'INSERT INTO settings (key, value) VALUES (?, ?)',
            settingKey,
            'exported-value'
        );
    } catch (error) {
        await dispose();
        throw error;
    }

    return {
        directory,
        settingKey,
        backupPath: path.join(directory, 'backup.db'),
        corruptPath: path.join(directory, 'corrupt.db'),
        dispose,
        async history() {
            const sessions = await database.query(
                `SELECT sessions.session_id, sessions.title, sessions.model, sessions.message_count,
                        providers.name AS provider_name
                 FROM sessions LEFT JOIN providers ON providers.id = sessions.provider_id
                 WHERE sessions.session_id IN (?, ?) ORDER BY sessions.session_id`,
                ...sessionKeys
            );
            const messages = await database.query(
                `SELECT sessions.session_id, messages.role, parts.type, parts.content, parts.data, parts.sort_order
                 FROM messages JOIN sessions ON sessions.id = messages.session_id
                 LEFT JOIN message_parts AS parts ON parts.message_id = messages.id
                 WHERE sessions.session_id IN (?, ?) ORDER BY sessions.session_id, messages.role, parts.sort_order`,
                ...sessionKeys
            );
            const turns = await database.query(
                `SELECT sessions.session_id, turns.task_id, turns.status, turns.prompt_snapshot_json,
                        models.model_id AS model_key, providers.name AS provider_name,
                        prompt.content AS prompt_content, response.content AS response_content
                 FROM session_turns AS turns LEFT JOIN sessions ON sessions.id = turns.session_id
                 JOIN models ON models.id = turns.model_id
                 JOIN providers ON providers.id = models.provider_id
                 LEFT JOIN message_parts AS prompt ON prompt.message_id = turns.prompt_message_id
                 LEFT JOIN message_parts AS response ON response.message_id = turns.response_message_id
                 WHERE turns.task_id = ? ORDER BY turns.id`,
                taskKey
            );
            return { sessions, messages, turns };
        },
        async unrelated() {
            const settings = await database.query(
                'SELECT key, value FROM settings WHERE key = ?',
                settingKey
            );
            const providers = await database.query(
                'SELECT name, driver, api_endpoint, enabled FROM providers WHERE name = ?',
                providerName
            );
            const models = await database.query(
                `SELECT name, model_id, is_default FROM models
                 WHERE provider_id IN (SELECT id FROM providers WHERE name = ?)`,
                providerName
            );
            return { settings, providers, models };
        },
    };
}

import fs from 'node:fs';
import { createRequire } from 'node:module';
import os from 'node:os';
import path from 'node:path';

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const require = createRequire(import.meta.url);
const { DatabaseSync } = require('node:sqlite');
const { waitForSessionSettled } = require('../../../e2e-tests/perf/completion.js');
const { seedAgentDatabase } = require('../../../e2e-tests/test/support/agent-fixture.js');

let root;
let database;
let databasePath;
const prompt = 'performance turn with rendered sentinel';

function insertTurn(text, status) {
    const session = database
        .prepare(
            "INSERT INTO sessions (session_id, title, model) VALUES (?, 'Measured turn', 'e2e-alpha')"
        )
        .run(text).lastInsertRowid;
    const message = database
        .prepare("INSERT INTO messages (session_id, role) VALUES (?, 'user')")
        .run(session).lastInsertRowid;
    database
        .prepare(
            "INSERT INTO message_parts (message_id, type, content, sort_order) VALUES (?, 'text', ?, 0)"
        )
        .run(message, text);
    database
        .prepare(
            "INSERT INTO session_turns (session_id, model_id, task_id, prompt_snapshot_json, prompt_message_id, status) VALUES (?, (SELECT id FROM models LIMIT 1), ?, '{}', ?, ?)"
        )
        .run(session, text, message, status);
}

beforeEach(() => {
    root = fs.mkdtempSync(path.join(os.tmpdir(), 'touchai-perf-completion-'));
    databasePath = path.join(root, 'touchai.db');
    seedAgentDatabase(databasePath, 'http://localhost:3426');
    database = new DatabaseSync(databasePath);
    vi.stubGlobal('$', () => ({ waitForExist: async () => undefined }));
    vi.stubGlobal('browser', {
        waitUntil: async (predicate) => {
            if (!(await predicate())) throw new Error('The turn did not durably complete');
        },
    });
});

afterEach(() => {
    database?.close();
    if (root) fs.rmSync(root, { recursive: true, force: true });
    vi.unstubAllGlobals();
});

describe('user accepts a performance sample after the renderer shows the sentinel', () => {
    it.each(['failed', 'cancelled', 'streaming'])(
        'user rejects an idle renderer whose own persisted turn is %s',
        async (status) => {
            insertTurn('previous successful turn', 'completed');
            insertTurn(prompt, status);
            await expect(waitForSessionSettled({ databasePath, prompt })).rejects.toThrow(/turn/i);
        }
    );

    it('user cannot substitute an older completed turn for a missing submitted turn', async () => {
        insertTurn('previous successful turn', 'completed');
        await expect(waitForSessionSettled({ databasePath, prompt })).rejects.toThrow(/turn/i);
    });

    it('user accepts an idle renderer only when its own submitted turn is durably completed', async () => {
        insertTurn(prompt, 'completed');
        await expect(waitForSessionSettled({ databasePath, prompt })).resolves.toBeUndefined();
    });
});

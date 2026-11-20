import fs from 'node:fs';
import { createRequire } from 'node:module';
import os from 'node:os';
import path from 'node:path';

import { afterEach, describe, expect, it } from 'vitest';

import { configureBaseFixture } from '../../../scripts/perf/710/run.mjs';

const require = createRequire(import.meta.url);
const { DatabaseSync } = require('node:sqlite');
const { seedAgentDatabase } = require('../../../e2e-tests/test/support/agent-fixture.js');

let root;
afterEach(() => {
    if (root) fs.rmSync(root, { recursive: true, force: true });
});

describe('user prepares the current desktop performance workload', () => {
    it('user gets one local model and the real setting tool from the shared isolated database fixture', () => {
        root = fs.mkdtempSync(path.join(os.tmpdir(), 'touchai-perf-fixture-'));
        const file = path.join(root, 'data/touchai.db');
        seedAgentDatabase(file, 'http://127.0.0.1:3426/v1');
        configureBaseFixture(file, 'test');
        const database = new DatabaseSync(file, { readOnly: true });
        try {
            expect(
                database
                    .prepare(
                        `SELECT models.model_id, providers.driver, providers.api_endpoint
                FROM models JOIN providers ON providers.id = models.provider_id
                WHERE models.is_default = 1 AND providers.enabled = 1`
                    )
                    .all()
            ).toEqual([
                {
                    model_id: 'perf-model',
                    driver: 'openai-compatible',
                    api_endpoint: 'http://127.0.0.1:3426/v1',
                },
            ]);
            expect(
                database.prepare('SELECT tool_id FROM built_in_tools WHERE enabled = 1').all()
            ).toEqual([{ tool_id: 'setting' }]);
            expect(database.prepare('PRAGMA integrity_check').get()).toEqual({
                integrity_check: 'ok',
            });
        } finally {
            database.close();
        }
    });
});

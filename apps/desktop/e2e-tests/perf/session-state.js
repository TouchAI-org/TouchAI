import { DatabaseSync } from 'node:sqlite';

export function seededSessionMessageId(historyLevel) {
    if (!Number.isInteger(historyLevel) || historyLevel < 1) return null;
    const role = historyLevel % 2 === 1 ? 'user' : 'assistant';
    return `${role}-${historyLevel}`;
}

export function isSeededSessionReady({ historyLevel, mountedMessageIds }) {
    const expectedId = seededSessionMessageId(historyLevel);
    return expectedId !== null && mountedMessageIds.includes(expectedId);
}

export async function waitForSessionSettled({ databasePath, prompt, timeoutMs = 120000 }) {
    // The rendered sentinel ends latency timing; only a committed turn validates the sample.
    const database = new DatabaseSync(databasePath, { readOnly: true });
    const observed = { status: null, error: null };
    try {
        database.exec('PRAGMA busy_timeout=1000');
        const query = database.prepare(`
            SELECT turn.status FROM session_turns AS turn
            JOIN message_parts AS part ON part.message_id = turn.prompt_message_id
            WHERE part.type = 'text' AND part.content = ?
        `);
        await browser.waitUntil(
            () => {
                const turns = query.all(prompt);
                if (turns.length > 1) {
                    observed.error = 'The measured prompt owns multiple turns';
                    return true;
                }
                observed.status = turns[0]?.status ?? null;
                return ['completed', 'failed', 'cancelled'].includes(observed.status);
            },
            { timeout: timeoutMs, timeoutMsg: 'The measured turn did not durably complete' }
        );
    } finally {
        database.close();
    }
    if (observed.error) throw new Error(observed.error);
    if (observed.status !== 'completed') {
        throw new Error(`The measured turn was durably ${observed.status ?? 'missing'}`);
    }
    await $('[data-testid="conversation-panel-host"] [role="log"][aria-busy="false"]').waitForExist(
        { timeout: timeoutMs }
    );
}

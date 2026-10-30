import { describe, expect, it } from 'vitest';

import { buildSessionSearchTrigramExpression } from '@/database/queries/sessionSearchTrigrams';

import { createMigratedDatabase, ftsRowIds } from './utils/migrations';

describe('buildSessionSearchTrigramExpression', () => {
    it('returns null for queries shorter than a trigram', () => {
        expect(buildSessionSearchTrigramExpression('')).toBeNull();
        expect(buildSessionSearchTrigramExpression('ab')).toBeNull();
    });

    it('returns null when the query contains a NUL byte', () => {
        expect(buildSessionSearchTrigramExpression('abc\0def')).toBeNull();
    });

    it('uses a single trigram for a three-codepoint query', () => {
        expect(buildSessionSearchTrigramExpression('abc')).toBe('"abc"');
    });

    it('spreads a second trigram across medium queries and honors the cap', () => {
        expect(buildSessionSearchTrigramExpression('abcde')).toBe('"abc" AND "cde"');
        expect(buildSessionSearchTrigramExpression('abcde', { maxTrigrams: 1 })).toBe('"abc"');
    });

    it('spreads multiple trigrams across the query', () => {
        const expression = buildSessionSearchTrigramExpression('abcdefghi');
        expect(expression).toBe('"abc" AND "def" AND "ghi"');
    });

    it('deduplicates identical trigrams', () => {
        expect(buildSessionSearchTrigramExpression('aaaaaa')).toBe('"aaa"');
    });

    it('escapes double quotes inside trigrams', () => {
        expect(buildSessionSearchTrigramExpression('ab"cd')).toBe('"ab""" AND """cd"');
    });
});

describe('trigram candidates narrow the FTS scan without changing matches', () => {
    function seededDatabase() {
        const db = createMigratedDatabase();
        db.exec(`
            INSERT INTO sessions (id, session_id, title, model) VALUES (1, 'a', 'one', 'm'), (2, 'b', 'two', 'm');
            INSERT INTO messages (id, session_id, role) VALUES (1, 1, 'user'), (2, 2, 'user');
            INSERT INTO message_parts (message_id, type, content, data, sort_order)
            VALUES (1, 'text', 'abc brv first', '{}', 0), (2, 'text', 'abc chr second', '{}', 0);
        `);
        return db;
    }

    it('matches only messages that contain every necessary trigram', () => {
        const db = seededDatabase();
        try {
            const expression = buildSessionSearchTrigramExpression('abcbrv');
            expect(expression).not.toBeNull();
            expect(ftsRowIds(db, expression!)).toEqual([1]);
        } finally {
            db.close();
        }
    });
});

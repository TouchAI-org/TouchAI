import { createHash } from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { describe, expect, it } from 'vitest';

import {
    FONT_FILENAME,
    provisionProductFont,
    verifyFontBuffer,
} from '../../../.github/ui-preview/lib/font.mjs';

const expectedFor = (data) => ({
    size: data.length,
    sha256: createHash('sha256').update(data).digest('hex'),
});

describe('user reviews evidence rendered with the product font', () => {
    it('user gets a pass only when the bytes match the product size and hash', () => {
        const data = Buffer.from('source-han-serif');

        expect(verifyFontBuffer(data, expectedFor(data))).toEqual({ ok: true });
    });

    it('user sees a substituted file rejected even when its size matches', () => {
        const expected = Buffer.from('source-han-serif');
        const substituted = Buffer.from('not-the-product-font');

        expect(verifyFontBuffer(substituted, expectedFor(expected)).ok).toBe(false);
    });

    it('user sees a truncated download rejected', () => {
        const expected = Buffer.from('source-han-serif');
        const truncated = expected.subarray(0, 8);

        expect(verifyFontBuffer(truncated, expectedFor(expected)).ok).toBe(false);
    });

    it('user gets the font when the first mirror fails and the second matches', async () => {
        const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'touchai-font-provision-'));
        const data = Buffer.from('source-han-serif');
        let callCount = 0;

        try {
            const result = await provisionProductFont({
                appRoot: directory,
                expected: expectedFor(data),
                sources: ['https://first.example/font.woff2', 'https://second.example/font.woff2'],
                log: () => {},
                fetchImpl: async () => {
                    callCount += 1;

                    if (callCount === 1) {
                        return { ok: false, status: 502 };
                    }

                    return { ok: true, status: 200, arrayBuffer: async () => data };
                },
            });

            expect(result).toEqual({
                ok: true,
                detail: 'downloaded from second.example',
            });
            expect(fs.readFileSync(path.join(directory, 'assets', 'font', FONT_FILENAME))).toEqual(
                data
            );
            expect(
                fs.existsSync(path.join(directory, 'assets', 'font', `${FONT_FILENAME}.download`))
            ).toBe(false);
        } finally {
            fs.rmSync(directory, { recursive: true, force: true });
        }
    });

    it('user gets no font or scratch file when every mirror returns invalid bytes', async () => {
        const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'touchai-font-provision-'));
        const fontDirectory = path.join(directory, 'assets', 'font');
        const target = path.join(fontDirectory, FONT_FILENAME);
        const scratch = `${target}.download`;
        const expected = Buffer.from('source-han-serif');
        const invalid = Buffer.from('not-the-product-font');
        fs.mkdirSync(fontDirectory, { recursive: true });
        fs.writeFileSync(scratch, 'stale');

        try {
            const result = await provisionProductFont({
                appRoot: directory,
                expected: expectedFor(expected),
                sources: ['https://first.example/font.woff2', 'https://second.example/font.woff2'],
                log: () => {},
                fetchImpl: async () => ({
                    ok: true,
                    status: 200,
                    arrayBuffer: async () => invalid,
                }),
            });

            expect(result.ok).toBe(false);
            expect(fs.existsSync(target)).toBe(false);
            expect(fs.existsSync(scratch)).toBe(false);
        } finally {
            fs.rmSync(directory, { recursive: true, force: true });
        }
    });
});

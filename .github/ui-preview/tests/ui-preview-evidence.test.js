import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import zlib from 'node:zlib';

import { afterEach, describe, expect, it } from 'vitest';

import { isMp4, readPngSize, validateEvidence } from '../lib/evidence.mjs';

const roots = [];

afterEach(() => {
    for (const root of roots.splice(0)) {
        fs.rmSync(root, { recursive: true, force: true });
    }
});

function crc32(buffer) {
    let crc = 0xffffffff;

    for (const byte of buffer) {
        crc ^= byte;

        for (let bit = 0; bit < 8; bit += 1) {
            crc = crc & 1 ? (crc >>> 1) ^ 0xedb88320 : crc >>> 1;
        }
    }

    return (crc ^ 0xffffffff) >>> 0;
}

function chunk(type, data) {
    const length = Buffer.alloc(4);
    length.writeUInt32BE(data.length);
    const typeBuffer = Buffer.from(type, 'ascii');
    const crc = Buffer.alloc(4);
    crc.writeUInt32BE(crc32(Buffer.concat([typeBuffer, data])));
    return Buffer.concat([length, typeBuffer, data, crc]);
}

function png(width, height) {
    const raw = Buffer.alloc((width * 3 + 1) * height);

    for (let y = 0; y < height; y += 1) {
        for (let x = 0; x < width * 3; x += 1) {
            raw[y * (width * 3 + 1) + 1 + x] = (x * 7 + y * 13) % 251;
        }
    }

    const header = Buffer.alloc(13);
    header.writeUInt32BE(width, 0);
    header.writeUInt32BE(height, 4);
    header[8] = 8;
    header[9] = 2;

    return Buffer.concat([
        Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
        chunk('IHDR', header),
        chunk('IDAT', zlib.deflateSync(raw)),
        chunk('IEND', Buffer.alloc(0)),
    ]);
}

function mp4(size = 20000) {
    const buffer = Buffer.alloc(size);
    buffer.writeUInt32BE(24, 0);
    buffer.write('ftypisom', 4, 'ascii');
    return buffer;
}

function makeRoot() {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'ui-preview-evidence-'));
    roots.push(root);
    return root;
}

function manifest(overrides = {}) {
    return {
        version: 1,
        sha: 'a1b2c3d4e5f6',
        scenes: [{ title: 'Search', shots: [{ file: 'evidence/search.png', caption: 'Search' }] }],
        video: 'evidence/recording.mp4',
        videoInfo: {
            durationSeconds: 12,
            frames: 360,
            distinctStates: 9,
            coverage: 0.98,
            width: 1280,
            height: 900,
        },
        ...overrides,
    };
}

describe('user publishes evidence that was recorded', () => {
    it('user gets a pass when the png and mp4 are real files', () => {
        const root = makeRoot();
        fs.mkdirSync(path.join(root, 'evidence'));
        fs.writeFileSync(path.join(root, 'evidence/search.png'), png(400, 200));
        fs.writeFileSync(path.join(root, 'evidence/recording.mp4'), mp4());

        const result = validateEvidence(root, manifest());

        expect(result.ok).toBe(true);
        expect(result.assets.shots).toEqual(['evidence/search.png']);
        expect(result.assets.video).toBe('evidence/recording.mp4');
    });

    it('user gets a failure when the manifest points outside the evidence directory', () => {
        const root = makeRoot();
        const result = validateEvidence(
            root,
            manifest({ scenes: [{ title: 'Search', shots: [{ file: '../secret.png' }] }] })
        );

        expect(result.ok).toBe(false);
        expect(result.errors.join(' ')).toContain('escapes the evidence directory');
    });

    it('user gets a failure when a screenshot is missing', () => {
        const root = makeRoot();
        const result = validateEvidence(root, manifest());

        expect(result.ok).toBe(false);
        expect(result.errors.join(' ')).toContain('shot is missing');
    });

    it('user gets a failure when a file claims to be a png but is not', () => {
        const root = makeRoot();
        fs.mkdirSync(path.join(root, 'evidence'));
        fs.writeFileSync(path.join(root, 'evidence/search.png'), Buffer.alloc(4096, 1));

        const result = validateEvidence(root, manifest({ video: null }));

        expect(result.ok).toBe(false);
        expect(result.errors.join(' ')).toContain('not a PNG');
    });

    it('user gets a failure when the video is truncated', () => {
        const root = makeRoot();
        fs.mkdirSync(path.join(root, 'evidence'));
        fs.writeFileSync(path.join(root, 'evidence/search.png'), png(400, 200));
        fs.writeFileSync(path.join(root, 'evidence/recording.mp4'), mp4(64));

        const result = validateEvidence(root, manifest());

        expect(result.ok).toBe(false);
        expect(result.errors.join(' ')).toContain('too small');
    });

    it('user gets a failure when the video is one static frame', () => {
        const root = makeRoot();
        fs.mkdirSync(path.join(root, 'evidence'));
        fs.writeFileSync(path.join(root, 'evidence/search.png'), png(400, 200));
        fs.writeFileSync(path.join(root, 'evidence/recording.mp4'), mp4());

        const result = validateEvidence(
            root,
            manifest({
                videoInfo: {
                    durationSeconds: 0.03,
                    frames: 1,
                    distinctStates: 1,
                    coverage: 0.001,
                    width: 1280,
                    height: 900,
                },
            })
        );

        expect(result.ok).toBe(false);
        expect(result.errors.join(' ')).toContain('effectively a still');
        expect(result.errors.join(' ')).toContain('fewer than 60 frames');
    });

    it('user gets a failure when the recording reports no metadata', () => {
        const root = makeRoot();
        fs.mkdirSync(path.join(root, 'evidence'));
        fs.writeFileSync(path.join(root, 'evidence/search.png'), png(400, 200));
        fs.writeFileSync(path.join(root, 'evidence/recording.mp4'), mp4());

        const result = validateEvidence(root, manifest({ videoInfo: undefined }));

        expect(result.ok).toBe(false);
        expect(result.errors.join(' ')).toContain('video metadata is missing');
    });

    it('user gets a failure when the manifest has no scenes', () => {
        const result = validateEvidence(makeRoot(), manifest({ scenes: [], video: null }));

        expect(result.ok).toBe(false);
        expect(result.errors.join(' ')).toContain('no scenes');
    });

    it('user gets a failure when the commit is not a sha', () => {
        const result = validateEvidence(makeRoot(), manifest({ sha: 'not-a-sha' }));

        expect(result.ok).toBe(false);
    });
});

describe('user reads file signatures', () => {
    it('user gets the pixel size of a real png', () => {
        expect(readPngSize(png(320, 120))).toEqual({ width: 320, height: 120 });
    });

    it('user gets nothing for a file that is not a png', () => {
        expect(readPngSize(Buffer.from('not a png at all'))).toBeNull();
    });

    it('user recognises an mp4 by its ftyp box', () => {
        expect(isMp4(mp4(64))).toBe(true);
    });

    it('user gets no mp4 for a text file', () => {
        expect(isMp4(Buffer.from('hello world, definitely not a video'))).toBe(false);
    });
});

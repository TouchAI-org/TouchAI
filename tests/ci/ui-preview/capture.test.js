import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { describe, expect, it } from 'vitest';

import {
    buildAss,
    DESKTOP_COLOUR,
    finalizeRecording,
    isPaintedWindowFrame,
    paintDesktop,
} from '../../../.github/ui-preview/lib/capture.mjs';

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../..');

describe('user reads the burned-in captions', () => {
    it('user sees a title for the whole recording and one caption per step', () => {
        const ass = buildAss({
            title: 'c616766 · Settings',
            durationMs: 12000,
            stage: { width: 1280, height: 800 },
            steps: [
                { startMs: 500, endMs: 3000, text: 'Open Settings' },
                { startMs: 3000, endMs: 6000, text: 'Open Shortcuts' },
            ],
        });

        expect(ass).toContain('Style: Title');
        expect(ass).toContain('c616766 · Settings');
        expect(ass).toContain('PlayResX: 1280');
        expect(ass).toContain('PlayResY: 800');
        expect(ass).toContain('0:00:00.50,0:00:03.00');
        expect(ass).toContain('0:00:03.00,0:00:06.00');
    });

    it('user never sees a caption run past the recording', () => {
        const ass = buildAss({
            durationMs: 4000,
            steps: [{ startMs: 3000, endMs: 9000, text: 'Last step' }],
        });

        expect(ass).toContain('0:00:03.00,0:00:04.00');
    });

    it('user gets a caption that cannot break the subtitle file', () => {
        const ass = buildAss({
            durationMs: 4000,
            steps: [{ startMs: 0, endMs: 1000, text: 'Click {settings} \\ done\nnext line' }],
        });

        expect(ass).toContain('Click settings \\\\ done next line');
        expect(ass).not.toContain('{\\');
    });
});

describe('user sees the real window edge against a light preview desktop', () => {
    it('user gets the same non-black backdrop on every capture platform', () => {
        const red = Number.parseInt(DESKTOP_COLOUR.slice(1, 3), 16);
        const green = Number.parseInt(DESKTOP_COLOUR.slice(3, 5), 16);
        const blue = Number.parseInt(DESKTOP_COLOUR.slice(5, 7), 16);
        const luminance = (red + green + blue) / (3 * 255);

        expect(DESKTOP_COLOUR).toBe('#d9d4c8');
        expect(luminance).toBeGreaterThan(0.7);

        for (const file of [
            '.github/ui-preview/with-display.sh',
            '.github/ui-preview/macos-display.swift',
            '.github/ui-preview/configure-display.ps1',
        ]) {
            expect(fs.readFileSync(path.join(repoRoot, file), 'utf8')).toContain(DESKTOP_COLOUR);
        }

        for (const file of ['.github/workflows/ui-preview.yml']) {
            expect(fs.readFileSync(path.join(repoRoot, file), 'utf8')).toContain(
                `UI_PREVIEW_DESKTOP_COLOUR: '${DESKTOP_COLOUR}'`
            );
        }

        expect(
            fs.readFileSync(path.join(repoRoot, '.github/ui-preview/with-display.sh'), 'utf8')
        ).toContain('feh --no-fehbg --bg-fill');

        const displayWrapper = fs.readFileSync(
            path.join(repoRoot, '.github/ui-preview/with-display.sh'),
            'utf8'
        );
        // The app disables native shadows on every platform. A compositor
        // shadow here would show a Linux-only edge that users never see.
        expect(displayWrapper).not.toContain('--shadow');
        expect(displayWrapper).not.toContain('--corner-radius');
    });
});

describe.skipIf(process.platform !== 'linux')(
    'user keeps the desktop pixmap the display wrapper published',
    () => {
        // The X11 helpers are Linux-only, and the fake commands rely on PATH
        // lookup, so this behaviour is exercised on the platform that runs it.
        function withFakeTools(xpropOutput, run) {
            const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'touchai-ui-preview-path-'));
            const marker = path.join(directory, 'xsetroot-called');
            const script = (body) => `#!/bin/sh\n${body}\n`;

            fs.writeFileSync(path.join(directory, 'xprop'), script(`echo '${xpropOutput}'`), {
                mode: 0o755,
            });
            fs.writeFileSync(path.join(directory, 'xsetroot'), script(`touch '${marker}'`), {
                mode: 0o755,
            });

            const originalPath = process.env.PATH;
            process.env.PATH = `${directory}${path.delimiter}${originalPath ?? ''}`;

            try {
                run();
                return fs.existsSync(marker);
            } finally {
                if (originalPath === undefined) {
                    delete process.env.PATH;
                } else {
                    process.env.PATH = originalPath;
                }
                fs.rmSync(directory, { recursive: true, force: true });
            }
        }

        it('user does not repaint the root window when a pixmap already exists', () => {
            const painted = withFakeTools('_XROOTPMAP_ID: 0x400001', () => paintDesktop(':99'));

            expect(painted).toBe(false);
        });

        it('user gets a solid backdrop when no pixmap exists', () => {
            const painted = withFakeTools('_XROOTPMAP_ID: not found.', () => paintDesktop(':99'));

            expect(painted).toBe(true);
        });
    }
);

describe('user keeps compact search screenshots', () => {
    it('user gets a low-complexity window frame but not a blank one', () => {
        const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'touchai-ui-preview-'));
        const compact = path.join(directory, 'compact.png');
        const blank = path.join(directory, 'blank.png');

        try {
            fs.writeFileSync(compact, Buffer.alloc(1674));
            fs.writeFileSync(blank, Buffer.alloc(312));

            expect(isPaintedWindowFrame(compact)).toBe(true);
            expect(isPaintedWindowFrame(blank)).toBe(false);
        } finally {
            fs.rmSync(directory, { recursive: true, force: true });
        }
    });
});

describe('user still gets a cropped recording when captions are unavailable', () => {
    it('user gets the crop fallback and a warning instead of the raw desktop', () => {
        const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'touchai-ui-preview-'));
        const input = path.join(directory, 'raw.mp4');
        const output = path.join(directory, 'recording.mp4');
        const calls = [];
        fs.writeFileSync(input, 'raw-video');

        try {
            const result = finalizeRecording({
                input,
                output,
                title: 'abc1234 · Settings',
                durationMs: 2000,
                steps: [{ startMs: 0, endMs: 1000, text: 'Open Settings' }],
                crop: 'crop=1280:900:0:0',
                runFfmpeg: (_command, args) => {
                    calls.push(args);
                    const target = args[args.length - 1];

                    if (calls.length === 1) {
                        fs.writeFileSync(target, 'partial');
                        return { status: 1, stderr: 'subtitles unavailable' };
                    }

                    fs.copyFileSync(input, target);
                    return { status: 0, stderr: '' };
                },
            });

            expect(result).toEqual({
                output,
                captionsBurned: false,
                cropped: true,
            });
            expect(calls).toHaveLength(2);
            expect(calls[0][calls[0].indexOf('-vf') + 1]).toContain(
                'ass=filename=.touchai-ui-preview-'
            );
            expect(calls[0][calls[0].indexOf('-vf') + 1]).not.toContain(directory);
            expect(calls[1][calls[1].indexOf('-vf') + 1]).toBe('crop=1280:900:0:0');
            expect(fs.readFileSync(output, 'utf8')).toBe('raw-video');
        } finally {
            fs.rmSync(directory, { recursive: true, force: true });
        }
    });
});

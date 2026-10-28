import { describe, expect, it } from 'vitest';

import { buildAss } from '../lib/capture.mjs';

describe('user reads the burned-in captions', () => {
    it('user sees a title for the whole recording and one caption per step', () => {
        const ass = buildAss({
            title: 'c616766 · Settings',
            durationMs: 12000,
            steps: [
                { startMs: 500, endMs: 3000, text: 'Open Settings' },
                { startMs: 3000, endMs: 6000, text: 'Open Shortcuts' },
            ],
        });

        expect(ass).toContain('Style: Title');
        expect(ass).toContain('c616766 · Settings');
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

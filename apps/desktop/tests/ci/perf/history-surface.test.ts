import { describe, expect, it } from 'vitest';

import { selectHistorySurface } from '../../../scripts/perf/710/history-surface.mjs';

describe('user opens a seeded RFC 710 history session', () => {
    it('user keeps the main window when history opens as an in-window overlay', () => {
        expect(
            selectHistorySurface({
                originalHandle: 'main',
                handles: ['main'],
                rowHandles: ['main'],
            })
        ).toBe('main');
    });

    it('user switches to the popup window when history opens separately', () => {
        expect(
            selectHistorySurface({
                originalHandle: 'main',
                handles: ['main', 'popup'],
                rowHandles: ['popup'],
            })
        ).toBe('popup');
    });

    it('user stays in the main window when both surfaces expose the seeded row', () => {
        expect(
            selectHistorySurface({
                originalHandle: 'main',
                handles: ['main', 'popup'],
                rowHandles: ['popup', 'main'],
            })
        ).toBe('main');
    });

    it('user reports no history surface when no window exposes the seeded row', () => {
        expect(
            selectHistorySurface({
                originalHandle: 'main',
                handles: ['main', 'popup'],
                rowHandles: [],
            })
        ).toBeNull();
    });
});

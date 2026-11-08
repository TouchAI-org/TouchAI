import { describe, expect, it } from 'vitest';

import { reportedPointer } from '@/services/ComputerUseService/pointer';

describe('computer operation pointer coordinates', () => {
    it('user given a batch of pointer actions when it finishes then sees the last reported position', () => {
        expect(
            reportedPointer({
                structuredContent: {
                    steps: [
                        { message: 'Clicked screen (100,200)' },
                        { message: 'Dragged screen (100,200) → (-300.5,450)' },
                    ],
                },
            })
        ).toEqual({ x: -300.5, y: 450 });
    });

    it('user given an action with no reported position when reading feedback then gets no invented point', () => {
        expect(reportedPointer({ content: [{ text: 'Typed 10 chars' }] })).toBeUndefined();
    });
});

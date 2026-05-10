import { describe, expect, it } from 'vitest';

import { bytesToArrayBuffer } from './content';

describe('bytesToArrayBuffer', () => {
    it('copies a byte view into an ArrayBuffer with matching bounds', () => {
        const source = new Uint8Array([0, 1, 2, 3, 4]);
        const view = source.subarray(1, 4);

        const buffer = bytesToArrayBuffer(view);

        expect(buffer).toBeInstanceOf(ArrayBuffer);
        expect(Array.from(new Uint8Array(buffer))).toEqual([1, 2, 3]);
    });
});

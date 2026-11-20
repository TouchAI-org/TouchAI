import { normalizeImageBytesToLimits } from '@/platform/files/image';

import {
    MAX_IMAGE_SOURCE_BYTES,
    MAX_INLINE_IMAGE_BASE64_CHARS,
    MAX_INLINE_IMAGE_EDGE,
} from './limits';
export type { NormalizedImageBytes } from '@/platform/files/image';

export function normalizeImageBytes(input: { bytes: Uint8Array; mimeType: string }) {
    return normalizeImageBytesToLimits(input, {
        maxSourceBytes: MAX_IMAGE_SOURCE_BYTES,
        maxBase64Chars: MAX_INLINE_IMAGE_BASE64_CHARS,
        maxEdge: MAX_INLINE_IMAGE_EDGE,
    });
}

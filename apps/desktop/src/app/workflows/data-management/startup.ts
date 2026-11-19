import { setMeta } from '@/database/queries/touchaiMeta';
import { MetaKey } from '@/database/schema';

import type { ImportMode } from './contracts';

export function serializeImportSuccessStartupPayload(importMode: ImportMode): string {
    return JSON.stringify({ type: 'import-success', version: 1, importMode });
}
export function recordImportSuccess(importMode: ImportMode): Promise<void> {
    return setMeta({
        key: MetaKey.IMPORT_SUCCESS,
        value: serializeImportSuccessStartupPayload(importMode),
    });
}

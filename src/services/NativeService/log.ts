import { invoke } from '@tauri-apps/api/core';

import type { TauriLogPayload } from './types';

export const log = {
    log(payload: TauriLogPayload): Promise<void> {
        return invoke('plugin:log|log', { ...payload });
    },
} as const;

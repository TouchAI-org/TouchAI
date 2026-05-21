import { invoke } from '@tauri-apps/api/core';

import type { RuntimeInfo } from './types';

export const runtime = {
    getRuntimeInfo(): Promise<RuntimeInfo> {
        return invoke<RuntimeInfo>('get_runtime_info');
    },
} as const;

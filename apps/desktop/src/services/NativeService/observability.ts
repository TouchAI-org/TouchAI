import { invoke } from '@tauri-apps/api/core';

import type { ObservabilityLogEnvelope } from './types';

export const observability = {
    ingest(batch: ObservabilityLogEnvelope[]): Promise<void> {
        return invoke('obs_ingest', { batch });
    },
    runId(): Promise<string> {
        return invoke('obs_run_id');
    },
} as const;

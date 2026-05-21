import { afterEach, beforeEach, vi } from 'vitest';

import { installTauriMocks, resetTauriMocks } from '../utils/tauri';

beforeEach(() => {
    installTauriMocks();
});

afterEach(() => {
    vi.restoreAllMocks();
    resetTauriMocks();
});

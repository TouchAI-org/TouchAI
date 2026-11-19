// Copyright (c) 2026. Qian Cheng. Licensed under GPL v3.

import type { DatabaseImportMode } from '@/platform/native/database';
import { database } from '@/platform/native/database';

/** Native owns backup consistency, import transactions and analytics scrubbing. */
export const exportBackup = (targetPath: string): Promise<void> =>
    database.exportBackup(targetPath);
export const importBackup = (sourcePath: string, mode: DatabaseImportMode): Promise<void> =>
    database.importBackup({ sourcePath, mode });

// Copyright (c) 2026. 千诚. Licensed under GPL v3

import { createDrizzleDb, rawQuery } from './driver';

export const db = createDrizzleDb();

export { rawQuery };
export type { DatabaseExecutor, DrizzleDb } from './driver';

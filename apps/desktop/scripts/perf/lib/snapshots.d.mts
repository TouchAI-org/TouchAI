export function prepareSnapshots(args: { baseline?: string; candidate?: string }): unknown;

export function verifyPreparedSnapshot(arm: string, snapshot: string, preparedRoot?: string): void;

export function linkSnapshotDependencies(snapshot: string, checkout?: string): void;

export type ImportMode = 'chat_only' | 'full';
export type HistoryCategory = 'sessions' | 'messages' | 'sessionTurns';
export interface DataStats {
    sessions: number;
    messages: number;
    sessionTurns: number;
}
export interface ProgressCallback {
    (message: string, progress: number): void;
}
export const dataManagementErrorCodes = [
    'DATABASE_BACKUP_CANCELLED',
    'DATA_MANAGEMENT_UNAVAILABLE',
    'DATA_MANAGEMENT_UNCONFIRMED',
] as const;
export class DataManagementError extends Error {
    constructor(readonly code: (typeof dataManagementErrorCodes)[number]) {
        super(code);
        this.name = 'DataManagementError';
    }
}
export function isDatabaseBackupCancelledError(error: unknown): boolean {
    return (
        typeof error === 'object' &&
        error !== null &&
        'code' in error &&
        error.code === 'DATABASE_BACKUP_CANCELLED'
    );
}
export interface DataManagementHost {
    stats(): Promise<DataStats>;
    clear(category: HistoryCategory): Promise<void>;
    exportBackup(targetPath: string): Promise<void>;
    importBackup(sourcePath: string, mode: ImportMode): Promise<void>;
}
export interface DataManagementApi {
    stats(): Promise<DataStats>;
    clear(category: HistoryCategory): Promise<void>;
    exportDatabase(onProgress?: ProgressCallback): Promise<string>;
    importDatabase(mode: ImportMode, onProgress?: ProgressCallback): Promise<boolean>;
    relaunch(): Promise<void>;
}

import type { DataManagementHost, ImportMode } from './contracts';
import { DataManagementError } from './contracts';

export function createDataManagement(input: {
    history: Pick<DataManagementHost, 'stats' | 'clear'>;
    backup: Pick<DataManagementHost, 'exportBackup' | 'importBackup'>;
    recordImport(mode: ImportMode): Promise<void>;
}) {
    let disposed = false;
    let active: Promise<void> | undefined;
    function requireOpen() {
        if (disposed) throw new DataManagementError('DATA_MANAGEMENT_UNAVAILABLE');
    }
    async function mutate(operation: () => Promise<void>): Promise<void> {
        requireOpen();
        if (active) throw new DataManagementError('DATA_MANAGEMENT_UNAVAILABLE');
        const pending = Promise.resolve().then(() => {
            requireOpen();
            return operation();
        });
        active = pending;
        try {
            await pending;
        } finally {
            if (active === pending) active = undefined;
        }
    }
    return Object.freeze({
        async stats() {
            requireOpen();
            return input.history.stats();
        },
        clear: (category: Parameters<DataManagementHost['clear']>[0]) =>
            mutate(() => input.history.clear(category)),
        exportBackup: (path: string) => mutate(() => input.backup.exportBackup(path)),
        importBackup: (path: string, mode: ImportMode) =>
            mutate(async () => {
                await input.backup.importBackup(path, mode);
                requireOpen();
                await input.recordImport(mode);
            }),
        async dispose() {
            disposed = true;
            await active?.catch(() => undefined);
        },
    });
}

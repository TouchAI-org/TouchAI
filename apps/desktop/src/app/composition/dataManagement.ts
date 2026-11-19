import { exportBackup, importBackup } from '@/database/backup';
import { createHistoryMaintenance } from '@/modules/agent';
import { requireMainExecutionHost } from '@/platform/windows/execution';

import { createDataManagement } from '../workflows/data-management/create';
import { recordImportSuccess } from '../workflows/data-management/startup';

export function assembleDataManagement() {
    requireMainExecutionHost();
    return createDataManagement({
        history: createHistoryMaintenance(),
        backup: { exportBackup, importBackup },
        recordImport: recordImportSuccess,
    });
}

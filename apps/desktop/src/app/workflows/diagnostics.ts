import { save } from '@tauri-apps/plugin-dialog';

import type { DiagnosticsAdminApi } from '@/app/api/windows/presentation';
import { t } from '@/i18n';
import { native } from '@/platform/native';

export function createDiagnosticsAdministration(signal: AbortSignal): DiagnosticsAdminApi {
    const active = () => {
        if (signal.aborted) throw new Error('WINDOW_CLOSED');
    };
    return Object.freeze<DiagnosticsAdminApi>({
        async readStatus() {
            active();
            return native.observability.diagnosticModeStatus();
        },
        async setEnabled(enabled) {
            active();
            return native.observability.setDiagnosticMode(enabled);
        },
        async preview() {
            active();
            return native.observability.previewBundle();
        },
        async dismissCrashes() {
            active();
            await native.observability.dismissCrashes();
        },
        async exportWithPicker() {
            active();
            const timestamp = new Date().toISOString().replace(/:/g, '-').slice(0, 19);
            const destination = await save({
                defaultPath: `TouchAI-diagnostics-${timestamp}.zip`,
                filters: [{ name: t('settings.diagnostics.dialogFilter'), extensions: ['zip'] }],
            });
            active();
            if (!destination) return false;
            await native.observability.exportBundle(destination);
            return true;
        },
    });
}

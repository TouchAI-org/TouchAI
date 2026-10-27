import { invoke } from './invoke';
import type {
    DiagnosticBundlePreview,
    DiagnosticModeStatus,
    ObservabilityLogEnvelope,
} from './types';

export const observability = {
    ingest(batch: ObservabilityLogEnvelope[]): Promise<void> {
        return invoke('obs_ingest', { batch });
    },
    runId(): Promise<string> {
        return invoke('obs_run_id');
    },
    setDiagnosticMode(enabled: boolean): Promise<DiagnosticModeStatus> {
        return invoke('obs_set_diagnostic_mode', { enabled });
    },
    diagnosticModeStatus(): Promise<DiagnosticModeStatus> {
        return invoke('obs_diagnostic_mode_status');
    },
    previewBundle(): Promise<DiagnosticBundlePreview> {
        return invoke('obs_preview_bundle');
    },
    exportBundle(destination: string): Promise<DiagnosticBundlePreview> {
        return invoke('obs_export_bundle', { destination });
    },
    dismissCrashes(): Promise<number> {
        return invoke('obs_dismiss_crashes');
    },
} as const;

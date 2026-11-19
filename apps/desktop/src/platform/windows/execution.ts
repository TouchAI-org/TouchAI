import { getCurrentWindow } from '@tauri-apps/api/window';

/** Routes and caller-provided labels are not evidence of native execution authority. */
export function getNativeWindowLabel(): string | null {
    try {
        return getCurrentWindow().label;
    } catch {
        return null;
    }
}

export function requireMainExecutionHost(): void {
    if (getNativeWindowLabel() !== 'main') throw new Error('MAIN_EXECUTION_HOST_REQUIRED');
}

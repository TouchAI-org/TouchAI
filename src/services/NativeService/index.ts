import { autostart } from './autostart';
import { log } from './log';
import { shortcut } from './shortcut';
import { window } from './window';

export type { PopupConfig, ShowPopupWindowParams, TauriLogPayload } from './types';

export { autostart, log, shortcut, window };

export const native = {
    window,
    shortcut,
    autostart,
    log,
} as const;

export type ShortcutCaptureCompletion =
    | {
          action: 'restore';
          displayShortcut: string;
      }
    | {
          action: 'skip';
          displayShortcut: string;
      }
    | {
          action: 'save';
          displayShortcut: string;
          shortcut: string;
      };

export function resolveShortcutCaptureCompletion({
    currentShortcut,
    displayShortcut,
    hasCapturedShortcut,
}: {
    currentShortcut: string;
    displayShortcut: string;
    hasCapturedShortcut: boolean;
}): ShortcutCaptureCompletion {
    if (!displayShortcut || !hasCapturedShortcut) {
        return {
            action: 'restore',
            displayShortcut: currentShortcut,
        };
    }

    if (displayShortcut === currentShortcut) {
        return {
            action: 'skip',
            displayShortcut,
        };
    }

    return {
        action: 'save',
        displayShortcut,
        shortcut: displayShortcut,
    };
}

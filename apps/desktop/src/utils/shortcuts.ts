export interface ShortcutMatchInput {
    key: string;
    code?: string;
    ctrlKey?: boolean;
    metaKey?: boolean;
    altKey?: boolean;
    shiftKey?: boolean;
}

export interface CapturedShortcutResult {
    shortcut: string;
    displayShortcut: string;
}

const MODIFIER_DISPLAY_ORDER = ['Mod', 'Ctrl', 'Alt', 'Shift'] as const;
const SUPPORTED_CAPTURE_MODIFIERS = new Set(['Ctrl', 'Alt', 'Shift', 'Mod']);
const SUPPORTED_CHARACTER_KEYS = new Set([
    ...'ABCDEFGHIJKLMNOPQRSTUVWXYZ'.split(''),
    ...'0123456789'.split(''),
    ',',
    '.',
    '=',
    '-',
    ';',
    '/',
    "'",
    '`',
    '[',
    ']',
    '\\',
]);
const SUPPORTED_NON_CHARACTER_KEYS = new Set([
    'Backspace',
    'Del',
    'Enter',
    'Esc',
    'Home',
    'End',
    'PageUp',
    'PageDown',
    'Tab',
    'Up',
    'Down',
    'Left',
    'Right',
    'Insert',
    'Space',
]);
const RESERVED_LOCAL_SHORTCUT_KEYS = new Set([
    'Backspace',
    'Del',
    'Enter',
    'Esc',
    'Home',
    'End',
    'PageUp',
    'PageDown',
    'Tab',
    'Up',
    'Down',
    'Left',
    'Right',
]);
const MODIFIER_KEYS = new Set(['Control', 'Alt', 'Shift', 'Meta', 'OS']);

const KEY_DISPLAY_MAP: Record<string, string> = {
    ' ': 'Space',
    Spacebar: 'Space',
    ArrowUp: 'Up',
    ArrowDown: 'Down',
    ArrowLeft: 'Left',
    ArrowRight: 'Right',
    Escape: 'Esc',
    Esc: 'Esc',
    Delete: 'Del',
    Del: 'Del',
    '.': '.',
    ',': ',',
};

const CODE_KEY_MAP: Record<string, string> = {
    Digit0: '0',
    Digit1: '1',
    Digit2: '2',
    Digit3: '3',
    Digit4: '4',
    Digit5: '5',
    Digit6: '6',
    Digit7: '7',
    Digit8: '8',
    Digit9: '9',
    Comma: ',',
    Period: '.',
    Equal: '=',
    Minus: '-',
    Semicolon: ';',
    Slash: '/',
    Quote: "'",
    Backquote: '`',
    BracketLeft: '[',
    BracketRight: ']',
    Backslash: '\\',
};

const ALIAS_MAP: Record<string, string> = {
    mod: 'Mod',
    cmd: 'Mod',
    command: 'Mod',
    meta: 'Mod',
    win: 'Mod',
    super: 'Mod',
    ctrl: 'Ctrl',
    control: 'Ctrl',
    option: 'Alt',
    alt: 'Alt',
    shift: 'Shift',
    esc: 'Esc',
    escape: 'Esc',
    delete: 'Del',
    del: 'Del',
    return: 'Enter',
    enter: 'Enter',
    tab: 'Tab',
    pageup: 'PageUp',
    pagedown: 'PageDown',
    arrowup: 'Up',
    up: 'Up',
    arrowdown: 'Down',
    down: 'Down',
    arrowleft: 'Left',
    left: 'Left',
    arrowright: 'Right',
    right: 'Right',
    backspace: 'Backspace',
    insert: 'Insert',
    ins: 'Insert',
    space: 'Space',
};

export function isMacPlatform(): boolean {
    if (typeof navigator === 'undefined') {
        return false;
    }

    return /(Mac|iPhone|iPad|iPod)/i.test(navigator.platform);
}

function getPrimaryModifierLabel(): 'Cmd' | 'Ctrl' {
    return isMacPlatform() ? 'Cmd' : 'Ctrl';
}

function getAltModifierLabel(): 'Option' | 'Alt' {
    return isMacPlatform() ? 'Option' : 'Alt';
}

function usesPrimaryModifier(input: ShortcutMatchInput): boolean {
    return isMacPlatform() ? Boolean(input.metaKey) : Boolean(input.ctrlKey);
}

function normalizeShortcutToken(token: string): string | null {
    const trimmed = token.trim();
    if (!trimmed) {
        return null;
    }

    const alias = ALIAS_MAP[trimmed.toLowerCase()];
    if (alias) {
        return alias;
    }

    if (trimmed.length === 1) {
        const normalizedCharacter = trimmed.toUpperCase();
        return SUPPORTED_CHARACTER_KEYS.has(normalizedCharacter) ? normalizedCharacter : null;
    }

    const functionKeyMatch = /^f(\d{1,2})$/i.exec(trimmed);
    if (functionKeyMatch) {
        const functionKeyNumber = Number(functionKeyMatch[1]);
        return functionKeyNumber >= 1 && functionKeyNumber <= 12 ? `F${functionKeyNumber}` : null;
    }

    if (SUPPORTED_NON_CHARACTER_KEYS.has(trimmed)) {
        return trimmed;
    }

    return null;
}

function normalizeEventKey(key: string): string | null {
    if (!key) {
        return null;
    }

    const mappedKey = KEY_DISPLAY_MAP[key] ?? key;
    return normalizeShortcutToken(mappedKey);
}

function normalizeFunctionKeyCode(code: string | null | undefined): string | null {
    if (!code) {
        return null;
    }

    const normalizedCode = normalizeShortcutToken(code);
    return normalizedCode && /^F\d{1,2}$/.test(normalizedCode) ? normalizedCode : null;
}

function normalizePrintableKeyCode(code: string | null | undefined): string | null {
    if (!code) {
        return null;
    }

    return normalizeShortcutToken(CODE_KEY_MAP[code] ?? '');
}

export function resolveKeyboardEventShortcutKey(
    key: string | null | undefined,
    code?: string | null
): string | null {
    const rawKey = key ?? '';
    const normalizedKey = normalizeEventKey(rawKey);
    const normalizedFunctionKeyCode = normalizeFunctionKeyCode(code);
    if (normalizedFunctionKeyCode && (!normalizedKey || !/^F\d{1,2}$/.test(normalizedKey))) {
        return normalizedFunctionKeyCode;
    }

    if (!normalizedKey && rawKey.length === 1) {
        return normalizePrintableKeyCode(code);
    }

    if (
        !normalizedKey &&
        code &&
        rawKey &&
        rawKey !== 'Dead' &&
        rawKey !== 'Process' &&
        rawKey !== 'Unidentified' &&
        rawKey !== 'Compose'
    ) {
        return null;
    }

    if (!normalizedKey) {
        return normalizePrintableKeyCode(code);
    }

    return normalizedKey;
}

function createShortcutParts(shortcut: string): { modifiers: string[]; key: string | null } {
    const normalizedParts = shortcut.split('+').map((part) => normalizeShortcutToken(part));
    if (normalizedParts.some((part) => !part)) {
        return { modifiers: [], key: null };
    }

    const parts = normalizedParts as string[];
    const modifierSet = new Set<string>();
    let key: string | null = null;
    for (const part of parts) {
        if (SUPPORTED_CAPTURE_MODIFIERS.has(part)) {
            modifierSet.add(part);
            continue;
        }

        if (key) {
            return { modifiers: [], key: null };
        }
        key = part;
    }

    if (!isMacPlatform() && modifierSet.has('Ctrl')) {
        modifierSet.delete('Ctrl');
        modifierSet.add('Mod');
    }

    const modifiers = MODIFIER_DISPLAY_ORDER.filter((modifier) => modifierSet.has(modifier));
    return { modifiers, key };
}

export function normalizeLocalShortcutString(shortcut: string | null | undefined): string | null {
    if (!shortcut) {
        return null;
    }

    const { modifiers, key } = createShortcutParts(shortcut);
    if (!key) {
        return null;
    }

    return [...modifiers, key].join('+');
}

export function formatShortcutForDisplay(shortcut: string | null | undefined): string {
    const normalized = normalizeLocalShortcutString(shortcut);
    if (!normalized) {
        return '—';
    }

    const { modifiers, key } = createShortcutParts(normalized);
    const displayModifiers = modifiers.map((modifier) => {
        if (modifier === 'Mod') {
            return getPrimaryModifierLabel();
        }
        if (modifier === 'Alt') {
            return getAltModifierLabel();
        }
        return modifier;
    });

    return [...displayModifiers, key].join('+');
}

export function toCurrentPlatformShortcut(shortcut: string | null | undefined): string | null {
    const normalized = normalizeLocalShortcutString(shortcut);
    if (!normalized) {
        return null;
    }

    return formatShortcutForDisplay(normalized);
}

export function matchShortcut(
    shortcut: string | null | undefined,
    input: ShortcutMatchInput
): boolean {
    const normalized = normalizeLocalShortcutString(shortcut);
    if (!normalized) {
        return false;
    }

    const { modifiers, key } = createShortcutParts(normalized);
    const eventKey = resolveKeyboardEventShortcutKey(input.key, input.code);
    if (!eventKey || eventKey !== key) {
        return false;
    }

    const isMac = isMacPlatform();
    const expectsMod = modifiers.includes('Mod');
    const expectsCtrl = modifiers.includes('Ctrl');
    const expectsAlt = modifiers.includes('Alt');
    const expectsShift = modifiers.includes('Shift');

    if (expectsMod !== usesPrimaryModifier(input)) {
        return false;
    }

    const effectiveCtrl = isMac
        ? Boolean(input.ctrlKey)
        : expectsMod
          ? false
          : Boolean(input.ctrlKey);
    if (expectsCtrl !== effectiveCtrl) {
        return false;
    }

    if (expectsAlt !== Boolean(input.altKey)) {
        return false;
    }

    if (expectsShift !== Boolean(input.shiftKey)) {
        return false;
    }

    if (!isMac && input.metaKey) {
        return false;
    }

    return true;
}

export function captureShortcutFromKeyboardEvent(
    event: KeyboardEvent
): CapturedShortcutResult | null {
    if (MODIFIER_KEYS.has(event.key)) {
        return null;
    }

    if (!isMacPlatform() && event.metaKey) {
        return null;
    }

    const key = resolveKeyboardEventShortcutKey(event.key, event.code);
    if (!key) {
        return null;
    }

    const modifiers: string[] = [];
    if (usesPrimaryModifier(event)) {
        modifiers.push('Mod');
    }
    if (event.ctrlKey && isMacPlatform()) {
        modifiers.push('Ctrl');
    }
    if (event.altKey) {
        modifiers.push('Alt');
    }
    if (event.shiftKey) {
        modifiers.push('Shift');
    }

    const shortcut = [...modifiers, key].join('+');
    return {
        shortcut,
        displayShortcut: formatShortcutForDisplay(shortcut),
    };
}

export function isReservedLocalShortcut(shortcut: string | null | undefined): boolean {
    const normalized = normalizeLocalShortcutString(shortcut);
    if (!normalized) {
        return false;
    }

    const { key } = createShortcutParts(normalized);
    return key ? RESERVED_LOCAL_SHORTCUT_KEYS.has(key) : false;
}

export function isReservedLocalShortcutKey(
    key: string | null | undefined,
    code?: string | null
): boolean {
    const normalizedKey = resolveKeyboardEventShortcutKey(key, code);
    return normalizedKey ? RESERVED_LOCAL_SHORTCUT_KEYS.has(normalizedKey) : false;
}

export function isReservedGlobalShortcut(shortcut: string | null | undefined): boolean {
    if (!isMacPlatform()) {
        return false;
    }

    const normalized = normalizeLocalShortcutString(shortcut);
    return normalized === 'Mod+Space' || normalized === 'Ctrl+Space';
}

export function hasRequiredModifier(shortcut: string | null | undefined): boolean {
    const normalized = normalizeLocalShortcutString(shortcut);
    if (!normalized) {
        return false;
    }

    const { modifiers } = createShortcutParts(normalized);
    return modifiers.length > 0;
}

export function hasCommandModifier(shortcut: string | null | undefined): boolean {
    const normalized = normalizeLocalShortcutString(shortcut);
    if (!normalized) {
        return false;
    }

    const { modifiers } = createShortcutParts(normalized);
    return modifiers.some(
        (modifier) => modifier === 'Mod' || modifier === 'Ctrl' || modifier === 'Alt'
    );
}

export function isModifierlessFunctionShortcut(shortcut: string | null | undefined): boolean {
    const normalized = normalizeLocalShortcutString(shortcut);
    if (!normalized) {
        return false;
    }

    const match = /^F(\d{1,2})$/.exec(normalized);
    if (!match) {
        return false;
    }

    const functionKeyNumber = Number(match[1]);
    return functionKeyNumber >= 1 && functionKeyNumber <= 12;
}

export function findShortcutConflict<T extends string>(
    shortcut: string | null | undefined,
    entries: Array<{ id: T; shortcut: string | null | undefined }>,
    excludeId?: T
): T | null {
    const normalized = normalizeLocalShortcutString(shortcut);
    if (!normalized) {
        return null;
    }

    for (const entry of entries) {
        if (excludeId && entry.id === excludeId) {
            continue;
        }

        if (normalizeLocalShortcutString(entry.shortcut) === normalized) {
            return entry.id;
        }
    }

    return null;
}

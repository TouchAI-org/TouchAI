import { watch } from 'vue';

import { locale, tt } from '.';

const NO_I18N_ATTRIBUTE = 'data-no-i18n';
const DISPLAY_ATTRIBUTES = [
    'placeholder',
    'title',
    'aria-label',
    'alt',
    'empty-text',
    'search-placeholder',
] as const;
const LOCALIZATION_BOUNDARY_ATTRIBUTES = [NO_I18N_ATTRIBUTE, 'translate'] as const;

const SKIPPED_TAGS = new Set(['SCRIPT', 'STYLE', 'CODE', 'PRE', 'TEXTAREA']);
const OBSERVED_ATTRIBUTES = [...DISPLAY_ATTRIBUTES, ...LOCALIZATION_BOUNDARY_ATTRIBUTES] as const;

interface TextRecord {
    original: string;
    translated: string;
}

interface AttributeRecord {
    original: string;
    translated: string;
}

export interface DomLocalizer {
    start(): void;
    stop(): void;
    translateNow(): void;
}

const textRecords = new WeakMap<Text, TextRecord>();
const attributeRecords = new WeakMap<Element, Map<string, AttributeRecord>>();

function isEditable(element: Element): boolean {
    if (!(element instanceof HTMLElement)) {
        return false;
    }

    return element.isContentEditable || element.getAttribute('contenteditable') === 'true';
}

function shouldSkipElement(element: Element | null): boolean {
    let current: Element | null = element;
    while (current) {
        if (
            SKIPPED_TAGS.has(current.tagName) ||
            isEditable(current) ||
            current.hasAttribute(NO_I18N_ATTRIBUTE) ||
            current.getAttribute('translate')?.toLowerCase() === 'no'
        ) {
            return true;
        }
        current = current.parentElement;
    }
    return false;
}

function splitBoundaryWhitespace(value: string): {
    leading: string;
    core: string;
    trailing: string;
} {
    const match = /^(\s*)([\s\S]*?)(\s*)$/.exec(value);
    if (!match) {
        return {
            leading: '',
            core: value,
            trailing: '',
        };
    }

    return {
        leading: match[1] ?? '',
        core: match[2] ?? '',
        trailing: match[3] ?? '',
    };
}

function translatePreservingWhitespace(value: string): string {
    const { leading, core, trailing } = splitBoundaryWhitespace(value);
    if (!core) {
        return value;
    }
    return `${leading}${tt(core)}${trailing}`;
}

function localizeTextNode(node: Text): void {
    if (shouldSkipElement(node.parentElement)) {
        return;
    }

    const currentValue = node.nodeValue ?? '';
    const record = textRecords.get(node) ?? {
        original: currentValue,
        translated: currentValue,
    };

    if (currentValue !== record.translated) {
        record.original = currentValue;
    }

    textRecords.set(node, record);
    const translatedValue = translatePreservingWhitespace(record.original);
    record.translated = translatedValue;
    if (currentValue !== translatedValue) {
        node.nodeValue = translatedValue;
    }
}

function getAttributeRecord(element: Element, attribute: string, value: string): AttributeRecord {
    let records = attributeRecords.get(element);
    if (!records) {
        records = new Map<string, AttributeRecord>();
        attributeRecords.set(element, records);
    }

    const existing = records.get(attribute);
    if (existing) {
        return existing;
    }

    const nextRecord = { original: value, translated: value };
    records.set(attribute, nextRecord);
    return nextRecord;
}

function localizeElementAttributes(element: Element): void {
    if (shouldSkipElement(element)) {
        return;
    }

    for (const attribute of DISPLAY_ATTRIBUTES) {
        const value = element.getAttribute(attribute);
        if (!value) {
            continue;
        }

        const record = getAttributeRecord(element, attribute, value);
        if (value !== record.translated) {
            record.original = value;
        }
        const translatedValue = translatePreservingWhitespace(record.original);
        record.translated = translatedValue;
        if (value !== translatedValue) {
            element.setAttribute(attribute, translatedValue);
        }
    }
}

function walkTextNodes(root: ParentNode, visitor: (node: Text) => void): void {
    const documentRef = root instanceof Document ? root : (root.ownerDocument ?? document);
    const walker = documentRef.createTreeWalker(root, NodeFilter.SHOW_TEXT);
    let node = walker.nextNode();

    while (node) {
        visitor(node as Text);
        node = walker.nextNode();
    }
}

function localizeTree(root: ParentNode): void {
    if (root instanceof Element) {
        localizeElementAttributes(root);
    }

    const elements = root instanceof Element ? root.querySelectorAll('*') : [];
    for (const element of elements) {
        localizeElementAttributes(element);
    }

    walkTextNodes(root, localizeTextNode);
}

export function createDomLocalizer(root: ParentNode = document.body): DomLocalizer {
    let observer: MutationObserver | null = null;
    let stopLocaleWatch: (() => void) | null = null;

    function translateNow(): void {
        observer?.disconnect();
        localizeTree(root);
        if (observer) {
            observer.observe(root, {
                childList: true,
                subtree: true,
                characterData: true,
                attributes: true,
                attributeFilter: [...OBSERVED_ATTRIBUTES],
            });
        }
    }

    function start(): void {
        translateNow();

        if (!observer) {
            observer = new MutationObserver(() => translateNow());
            observer.observe(root, {
                childList: true,
                subtree: true,
                characterData: true,
                attributes: true,
                attributeFilter: [...OBSERVED_ATTRIBUTES],
            });
        }

        if (!stopLocaleWatch) {
            stopLocaleWatch = watch(locale, () => translateNow(), { flush: 'post' });
        }
    }

    function stop(): void {
        observer?.disconnect();
        observer = null;
        stopLocaleWatch?.();
        stopLocaleWatch = null;
    }

    return {
        start,
        stop,
        translateNow,
    };
}

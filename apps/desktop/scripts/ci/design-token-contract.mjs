// Copyright (c) 2026. 千诚. Licensed under GPL v3

import { readdirSync, readFileSync } from 'node:fs';
import { dirname, join, relative, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const SCRIPT_DIRECTORY = dirname(fileURLToPath(import.meta.url));
const REPOSITORY_ROOT = resolve(SCRIPT_DIRECTORY, '../../../..');
const STYLE_DIRECTORY = join(REPOSITORY_ROOT, 'apps/desktop/src/styles');
const SCAN_ROOT = join(REPOSITORY_ROOT, 'apps/desktop/src');

/** Utilities whose suffix is a colour, so the suffix must resolve to a token. */
const COLOR_PREFIXES = [
    'bg',
    'text',
    'border',
    'ring',
    'fill',
    'stroke',
    'from',
    'to',
    'via',
    'divide',
    'outline',
    'decoration',
    'placeholder',
    'caret',
    'accent',
    'inset-ring',
];

/** Tailwind's built-in palette, which resolves without an `@theme` entry. */
const DEFAULT_PALETTE = new Set([
    'slate',
    'gray',
    'zinc',
    'neutral',
    'stone',
    'red',
    'orange',
    'amber',
    'yellow',
    'lime',
    'green',
    'emerald',
    'teal',
    'cyan',
    'sky',
    'blue',
    'indigo',
    'violet',
    'purple',
    'fuchsia',
    'pink',
    'rose',
]);

const DEFAULT_SHADES = new Set([
    '50',
    '100',
    '200',
    '300',
    '400',
    '500',
    '600',
    '700',
    '800',
    '900',
    '950',
]);

/** Sides accepted by the directional border utilities. */
const BORDER_SIDES = new Set(['t', 'b', 'l', 'r', 'x', 'y', 's', 'e']);

const BORDER_STYLES = new Set(['solid', 'dashed', 'dotted', 'double', 'none', 'hidden']);

const KEYWORDS = new Set([
    'none',
    'auto',
    'inherit',
    'initial',
    'unset',
    'revert',
    'transparent',
    'current',
    'white',
    'black',
    'full',
    'px',
    'screen',
    'min',
    'max',
    'fit',
]);

const BG_KEYWORDS = new Set([
    'fixed',
    'local',
    'scroll',
    'clip-text',
    'cover',
    'contain',
    'repeat',
    'no-repeat',
    'round',
    'space',
    'center',
    'top',
    'bottom',
    'left',
    'right',
    'gradient-to-t',
    'gradient-to-tr',
    'gradient-to-r',
    'gradient-to-br',
    'gradient-to-b',
    'gradient-to-bl',
    'gradient-to-l',
    'gradient-to-tl',
]);

const DECORATION_KEYWORDS = new Set([
    'solid',
    'dashed',
    'dotted',
    'double',
    'wavy',
    'auto',
    'from-font',
    'underline',
    'overline',
    'line-through',
    'no-underline',
    'clip',
    'slice',
]);

const TEXT_KEYWORDS = new Set([
    'left',
    'center',
    'right',
    'justify',
    'start',
    'end',
    'ellipsis',
    'clip',
    'wrap',
    'nowrap',
    'balance',
    'pretty',
    'top',
    'bottom',
    'middle',
    'baseline',
]);

/** `text-*` suffixes that are font sizes rather than colours. */
const FONT_SIZE_SUFFIXES = new Set([
    'xs',
    'sm',
    'base',
    'lg',
    'xl',
    '2xl',
    '3xl',
    '4xl',
    '5xl',
    '6xl',
    '7xl',
    '8xl',
    '9xl',
]);

const RING_KEYWORDS = new Set(['inset', 'offset']);

function listFiles(directory, extensions) {
    const files = [];

    for (const entry of readdirSync(directory, { withFileTypes: true })) {
        const absolutePath = join(directory, entry.name);

        if (entry.isDirectory()) {
            files.push(...listFiles(absolutePath, extensions));
            continue;
        }

        if (extensions.some((extension) => entry.name.endsWith(extension))) {
            files.push(absolutePath);
        }
    }

    return files;
}

/**
 * Collects every custom property declared inside an `@theme` block.
 *
 * Tailwind v4 only generates utilities for `@theme` entries, so this set is the
 * authoritative list of tokens that actually exist.
 *
 * @returns {Set<string>}
 */
export function collectThemeTokens(styleDirectory = STYLE_DIRECTORY) {
    const tokens = new Set();

    for (const absolutePath of listFiles(styleDirectory, ['.css'])) {
        const source = readFileSync(absolutePath, 'utf8');
        const themeBlocks = source.matchAll(/@theme(?:\s+inline)?\s*\{([\s\S]*?)\n\}/g);

        for (const block of themeBlocks) {
            for (const declaration of block[1].matchAll(/^\s*(--[a-zA-Z0-9-]+)\s*:/gm)) {
                tokens.add(declaration[1]);
            }
        }
    }

    return tokens;
}

/**
 * Extracts class attribute values together with their absolute source offset.
 *
 * Bound `:class` expressions are mined for string literals only: object keys and
 * identifiers cannot be resolved statically, so they are skipped on purpose.
 *
 * @returns {{ value: string, index: number }[]}
 */
function extractClassAttributes(source) {
    const attributes = [];

    for (const match of source.matchAll(/\sclass="([^"]*)"/g)) {
        attributes.push({ value: match[1], index: match.index + match[0].indexOf(match[1]) });
    }

    for (const match of source.matchAll(/\s:class="([^"]*)"/g)) {
        const expression = match[1];
        const expressionStart = match.index + match[0].indexOf(expression);

        for (const literal of expression.matchAll(/'([^']*)'|`([^`]*)`/g)) {
            const value = literal[1] ?? literal[2] ?? '';
            attributes.push({ value, index: expressionStart + literal.index });
        }
    }

    return attributes;
}

function stripVariants(utilityClass) {
    const segments = utilityClass.replace(/^!/, '').split(':');
    return segments[segments.length - 1];
}

function stripOpacity(suffix) {
    return suffix.replace(/\/(?:\d+|\[[^\]]+\])$/, '');
}

/**
 * Which token namespaces a given utility prefix may legitimately resolve through.
 *
 * Checking every namespace for every prefix would accept nonsense such as
 * `bg-text-primary` (a `--text-*` token reached from a `bg-` utility), which is
 * exactly the class of mistake this check exists to catch.
 */
const PREFIX_NAMESPACES = {
    bg: ['color'],
    border: ['color'],
    ring: ['color'],
    'inset-ring': ['color', 'inset-shadow'],
    fill: ['color'],
    stroke: ['color'],
    from: ['color'],
    to: ['color'],
    via: ['color'],
    divide: ['color'],
    outline: ['color'],
    decoration: ['color'],
    placeholder: ['color'],
    caret: ['color'],
    accent: ['color'],
    text: ['color', 'text'],
};

function resolvesToToken(themeTokens, prefix, suffix) {
    const namespaces = PREFIX_NAMESPACES[prefix] ?? ['color'];

    return namespaces.some((namespace) => themeTokens.has(`--${namespace}-${suffix}`));
}

function isDefaultPaletteColor(suffix) {
    const match = suffix.match(/^([a-z]+)-(\d{2,3})$/);
    if (!match) {
        return false;
    }

    return DEFAULT_PALETTE.has(match[1]) && DEFAULT_SHADES.has(match[2]);
}

/**
 * Decides whether a utility suffix is structural (width, side, style) rather than
 * a colour reference.
 */
function isStructuralSuffix(prefix, suffix) {
    if (KEYWORDS.has(suffix)) {
        return true;
    }

    if (prefix === 'bg') {
        return (
            BG_KEYWORDS.has(suffix) || suffix.startsWith('origin-') || suffix.startsWith('blend-')
        );
    }

    if (prefix === 'text') {
        return TEXT_KEYWORDS.has(suffix) || FONT_SIZE_SUFFIXES.has(suffix);
    }

    if (prefix === 'decoration') {
        return DECORATION_KEYWORDS.has(suffix) || /^\d+$/.test(suffix);
    }

    if (prefix === 'border') {
        if (BORDER_SIDES.has(suffix) || BORDER_STYLES.has(suffix)) {
            return true;
        }
        return /^\d+$/.test(suffix);
    }

    if (prefix === 'divide') {
        return /^[xy](?:-\d+)?$/.test(suffix) || /^\d+$/.test(suffix);
    }

    if (prefix === 'outline') {
        return /^(?:offset-)?\d+$/.test(suffix) || BORDER_STYLES.has(suffix);
    }

    if (prefix === 'ring' || prefix === 'inset-ring') {
        return /^(?:offset-)?\d+$/.test(suffix) || RING_KEYWORDS.has(suffix);
    }

    if (prefix === 'fill' || prefix === 'stroke') {
        return /^\d+$/.test(suffix);
    }

    if (prefix === 'from' || prefix === 'to' || prefix === 'via') {
        return /^\d+(?:\.\d+)?%$/.test(suffix);
    }

    if (prefix === 'accent') {
        return suffix === 'auto';
    }

    return false;
}

/**
 * Finds colour utilities that neither resolve to a token nor to a default
 * palette colour.
 *
 * These render only because a hand-written stylesheet happens to define the
 * class. Tailwind emits no warning and `vue-tsc` does not inspect class names, so
 * the failure mode is a silently unstyled element after a refactor.
 *
 * @param {Set<string>} themeTokens
 * @param {string} [rootDirectory]
 * @returns {{ token: string, file: string, line: number }[]}
 */
export function findUnresolvedColorUtilities(themeTokens, rootDirectory = SCAN_ROOT) {
    const findings = [];
    const seen = new Set();

    for (const absolutePath of listFiles(rootDirectory, ['.vue'])) {
        const source = readFileSync(absolutePath, 'utf8');
        const relativePath = relative(REPOSITORY_ROOT, absolutePath).replace(/\\/g, '/');

        for (const attribute of extractClassAttributes(source)) {
            for (const match of attribute.value.matchAll(/\S+/g)) {
                const utilityClass = stripVariants(match[0]);
                const separatorIndex = utilityClass.indexOf('-');

                if (separatorIndex < 0) {
                    continue;
                }

                const prefix = utilityClass.slice(0, separatorIndex);
                if (!COLOR_PREFIXES.includes(prefix)) {
                    continue;
                }

                let suffix = stripOpacity(utilityClass.slice(separatorIndex + 1));

                if (!suffix || suffix.startsWith('[') || suffix.startsWith('(')) {
                    continue;
                }

                // `border-t-primary-500` carries a side modifier before the colour.
                if (prefix === 'border') {
                    const sideMatch = suffix.match(/^([tblrxyse])-(.+)$/);
                    if (sideMatch) {
                        suffix = stripOpacity(sideMatch[2]);
                        if (suffix.startsWith('[') || suffix.startsWith('(')) {
                            continue;
                        }
                    }
                }

                if (isStructuralSuffix(prefix, suffix)) {
                    continue;
                }

                if (isDefaultPaletteColor(suffix) || resolvesToToken(themeTokens, prefix, suffix)) {
                    continue;
                }

                const key = `${prefix}-${suffix}`;
                if (seen.has(key)) {
                    continue;
                }

                seen.add(key);
                const absoluteIndex = attribute.index + match.index;
                const line = source.slice(0, absoluteIndex).split('\n').length;

                findings.push({ token: key, file: relativePath, line });
            }
        }
    }

    return findings;
}

/**
 * Validates that every colour utility used in a template resolves.
 *
 * @param {Set<string>} themeTokens
 * @param {string} [rootDirectory]
 * @returns {string[]}
 */
export function evaluateTokenContract(themeTokens, rootDirectory = SCAN_ROOT) {
    return findUnresolvedColorUtilities(themeTokens, rootDirectory).map(
        (finding) =>
            `${finding.token} is used at ${finding.file}:${finding.line} but no --color-*, --text-*, --shadow-*, --font-* or --radius-* token defines it, and it is not a Tailwind palette colour.`
    );
}

function main() {
    const themeTokens = collectThemeTokens();

    if (process.argv.includes('--report')) {
        const findings = findUnresolvedColorUtilities(themeTokens);
        console.log(`Theme tokens: ${themeTokens.size}`);
        console.log(`Unresolved colour utilities: ${findings.length}\n`);
        for (const finding of findings) {
            console.log(`  ${finding.token.padEnd(28)} ${finding.file}:${finding.line}`);
        }
        return;
    }

    const errors = evaluateTokenContract(themeTokens);

    if (errors.length > 0) {
        console.error('\nDesign-token contract check failed:');
        for (const error of errors) {
            console.error(`  - ${error}`);
        }
        console.error(
            '\nDeclare the missing token in apps/desktop/src/styles/tokens/ or switch to an existing semantic token.'
        );
        process.exit(1);
    }

    console.log(`Design-token contract check passed (${themeTokens.size} theme tokens).`);
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
    main();
}

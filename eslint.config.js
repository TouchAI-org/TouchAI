import eslint_js from '@eslint/js'
import { defineConfig, globalIgnores } from 'eslint/config'
import eslintPluginPrettierRecommended from 'eslint-plugin-prettier/recommended'
import simpleImportSort from 'eslint-plugin-simple-import-sort'
import eslintPluginTailwind from 'eslint-plugin-tailwindcss'
import eslint_vue from 'eslint-plugin-vue'
import globals from 'globals'
import * as eslint_ts from 'typescript-eslint'
import vue_parser from 'vue-eslint-parser'

/*
 * Design-system guards.
 *
 * Two layers, because ESLint cannot see both halves of a Vue file with one
 * mechanism:
 *
 *   Templates are handled by eslint-plugin-tailwindcss. It resolves the real
 *   theme through cssConfigPath and reports arbitrary values and unknown
 *   utilities wherever they appear, including class="" attributes — which core
 *   ESLint rules never traverse. This covers colours, sizes, radii and exotic
 *   values (font-[...], p-[...]) with one maintained rule set.
 *
 *   Scripts are handled by no-restricted-syntax below. Core ESLint sees class
 *   strings written in cva definitions, variant maps and constants, so that is
 *   where the selector-based rules apply.
 *
 * The split matters: a selector like `VLiteral[value=/…/]` compiles, matches
 * nothing, and gives a false sense of coverage. That mistake is why the template
 * half is delegated to a plugin that has the AST support for it.
 *
 * Existing violations are handled by ESLint's own bulk suppressions
 * (--suppress-all, eslint-suppressions.json) rather than a bespoke baseline file.
 * Suppressions are per line and per rule, so a suppressed line keeps its
 * protection: editing it brings the violation back. Run `pnpm design:prune` after
 * fixing anything to drop the stale entries.
 */

/** Classes declared in @layer components, which Tailwind does not emit as utilities. */
const PROJECT_COMPONENT_CLASS_PATTERNS = [
    '^settings-.*',
    '^t-.*',
    '^ask-.*',
    '^ask-user.*',
    '^conversation-.*',
    '^quick-search.*',
    '^custom-scrollbar.*',
    '^tool-call-log.*',
    '^toolbar-button$',
    '^dot$',
    '^web-search-sources__.*',
    '^markdown-.*',
    '^touchai-.*',
    '^no-scrollbar$',
]

/** Palette utilities that bypass the semantic roles. */
const PALETTE_UTILITY =
    String.raw`(?:bg|text|border|ring|fill|stroke|divide|from|to|via)-(?:white|black|neutral|gray|stone|slate|zinc)(?:-\d{2,3})?(?:\/\d{1,3})?`
const PALETTE_CLASS_PATTERN = String.raw`(?<![\w-])${PALETTE_UTILITY}(?![\w-])`

/** Arbitrary values, mirroring the Tailwind plugin's rule for script-side class strings. */
const ARBITRARY_VALUE =
    String.raw`(?:bg|text|font|border|ring|ring-offset|fill|stroke|from|to|via|divide|outline|decoration|accent|caret|placeholder|shadow|inset-ring|rounded(?:-[trblse])?|leading|tracking|p[trblxy]?|m[trblxy]?|gap(?:-[xy])?|space-[xy]|w|h|min-w|min-h|max-w|max-h|size|z|top|right|bottom|left|inset(?:-[xy])?|blur|opacity)-\[[^\]]+\]`

const SCRIPT_DESIGN_SYSTEM_SELECTORS = [
    {
        selector: `Literal[value=/${PALETTE_CLASS_PATTERN}/]`,
        message:
            'Direct palette utility in a class string. Use a semantic token (bg-surface-*, text-text-*, border-*) instead.',
    },
    {
        selector: `TemplateElement[value.raw=/${PALETTE_CLASS_PATTERN}/]`,
        message:
            'Direct palette utility in a template literal. Use a semantic token (bg-surface-*, text-text-*, border-*).',
    },
    {
        selector: `Literal[value=/${ARBITRARY_VALUE}/]`,
        message:
            'Arbitrary value in a class string. Add a token under apps/desktop/src/styles/tokens/ and use it.',
    },
    {
        selector: `TemplateElement[value.raw=/${ARBITRARY_VALUE}/]`,
        message:
            'Arbitrary value in a template literal. Add a token under apps/desktop/src/styles/tokens/ and use it.',
    },
]

/** Template palette utilities. `vue/no-restricted-class` matches whole class tokens, with variants. */
const TEMPLATE_PALETTE_PATTERNS = [
    String.raw`/^(?:.*:)?${PALETTE_UTILITY}$/`,
]

export default defineConfig([
    // 基础配置
    {
        plugins: {
            'simple-import-sort': simpleImportSort,
        },
        rules: {
            'simple-import-sort/imports': 'error',
            'simple-import-sort/exports': 'error',
        },
    },
    {
        languageOptions: {
            ecmaVersion: 2022,
            sourceType: 'module',
            globals: {
                ...globals.browser,
                ...globals.node,
            },
        },
    },
    {
        files: ['e2e-tests/**/*.js', 'apps/desktop/e2e-tests/**/*.js'],
        languageOptions: {
            globals: {
                ...globals.mocha,
                browser: 'readonly',
                $: 'readonly',
                $$: 'readonly',
                expect: 'readonly',
            },
        },
    },
    // 忽略文件
    globalIgnores([
        'node_modules',
        '**/node_modules',
        '**/node_modules/**',
        'dist',
        'dist/**',
        '**/dist',
        '**/dist/**',
        'build',
        'build/**',
        '**/build',
        '**/build/**',
        'coverage',
        'coverage/**',
        '**/coverage',
        '**/coverage/**',
        '.vite-cache',
        '.vite-cache/**',
        '**/.vite-cache',
        '**/.vite-cache/**',
        'apps/desktop/data',
        'apps/desktop/data/**',
        '.coverage',
        '.coverage/**',
        '**/.coverage',
        '**/.coverage/**',
        'src-tauri',
        'src-tauri/**',
        '**/src-tauri',
        '**/src-tauri/**',
        'apps/desktop/src-tauri',
        'apps/desktop/src-tauri/**',
        'apps/site/dist',
        'apps/site/dist/**',
        '.astro',
        '.astro/**',
        '**/.astro',
        '**/.astro/**',
        '.e2e-runtime',
        '.e2e-runtime/**',
        '**/.e2e-runtime',
        '**/.e2e-runtime/**',
        '.e2e-tools',
        '.e2e-tools/**',
        '**/.e2e-tools',
        '**/.e2e-tools/**',
        '.cargo-temp',
        '.cargo-temp/**',
        'rust-target',
        'rust-target/**',
        '**/rust-target',
        '**/rust-target/**',
        'rust-temp',
        'rust-temp/**',
        '**/rust-temp',
        '**/rust-temp/**',
        'tmp-cargo-target',
        'tmp-cargo-target/**',
        'tmp-cargo-temp',
        'tmp-cargo-temp/**',
        '**/target',
        '**/target/**',
        '**/gen',
        '**/gen/**',
        '**/*d.ts',
        '.worktrees',
        '.tmp',
        '.codex',
    ]),
    // 推荐配置
    eslint_js.configs.recommended,
    ...eslint_ts.configs.recommended,
    ...eslint_vue.configs['flat/recommended'],
    // Prettier
    eslintPluginPrettierRecommended,
    {
        files: ['**/*.config.{js,ts,mjs,cjs}'],
        rules: {
            'prettier/prettier': 'off',
        },
    },
    // Typescript解析
    {
        files: ['**/*.vue'],
        languageOptions: {
            parser: vue_parser,
            parserOptions: {
                sourceType: 'module',
                parser: eslint_ts.parser,
            },
        },
        rules: {
            'vue/no-v-html': 'off',
        },
    },
    /*
     * Design-system enforcement, template half.
     *
     * `no-arbitrary-value` covers every arbitrary utility the audit catalogued:
     * hex colours, pixel sizes, radii, and exotic values such as
     * `font-[JetBrains_Mono,monospace]`. It resolves the project theme through
     * `cssConfigPath`, so the custom tokens registered in tokens/*.css are
     * recognised and do not produce false positives.
     *
     * `no-custom-classname` catches utilities that do not exist at all — the class
     * of mistake that silently renders nothing. Project component classes defined
     * in @layer components are whitelisted because Tailwind does not emit them as
     * utilities, so the plugin cannot know about them.
     *
     * `vue/no-restricted-class` covers the one thing the Tailwind plugin treats as
     * valid but the design system does not: palette utilities such as `bg-white`
     * and `text-neutral-500`. They compile and render; they just bypass the
     * semantic roles.
     */
    {
        files: ['apps/desktop/src/**/*.vue'],
        plugins: {
            tailwindcss: eslintPluginTailwind,
        },
        settings: {
            tailwindcss: {
                // Relative to the lint working directory (apps/desktop), which is
                // where lint:check runs.
                cssConfigPath: 'src/styles/tailwind.css',
            },
        },
        rules: {
            'tailwindcss/no-arbitrary-value': 'error',
            'tailwindcss/no-custom-classname': ['error', { whitelist: PROJECT_COMPONENT_CLASS_PATTERNS }],
            'vue/no-restricted-class': ['error', ...TEMPLATE_PALETTE_PATTERNS],
        },
    },
    /*
     * Design-system enforcement, script half.
     *
     * Core ESLint sees class strings in cva definitions, variant maps and
     * constants. It cannot see template attributes, so this block deliberately
     * covers only the palette utilities that the Tailwind plugin treats as valid —
     * `bg-white` and `bg-neutral-100` are real utilities, just the wrong ones.
     */
    {
        files: ['apps/desktop/src/**/*.{ts,vue}'],
        rules: {
            'no-restricted-syntax': ['error', ...SCRIPT_DESIGN_SYSTEM_SELECTORS],
        },
    },
])

import eslint_js from '@eslint/js'
import { defineConfig, globalIgnores } from 'eslint/config'
import eslintPluginPrettierRecommended from 'eslint-plugin-prettier/recommended'
import simpleImportSort from 'eslint-plugin-simple-import-sort'
import eslint_vue from 'eslint-plugin-vue'
import globals from 'globals'
import * as eslint_ts from 'typescript-eslint'
import vue_parser from 'vue-eslint-parser'

/*
 * Design-system guards.
 *
 * These catch the drift classes that the audit measured entering through ordinary
 * feature PRs. They are intentionally narrow: each selector targets a value that a
 * token or primitive already covers. A rule that fires on legitimate styling trains
 * people to add eslint-disable comments, which is worse than not having the rule.
 *
 * Scope, and why it is what it is:
 *   ESLint core rules only traverse the <script> block of a .vue file. Template
 *   attributes are invisible to them, so a selector like `VLiteral[value=/…/]`
 *   compiles, matches nothing, and gives a false sense of coverage. What this
 *   config therefore guards is class strings written in script: cva definitions,
 *   variant maps, and class constants.
 *
 *   Template classes are guarded by scripts/ci/design-drift-budget.mjs, which
 *   scans the raw .vue text and rejects any newly added arbitrary value. That
 *   script is the CI gate; this config is the editor-time signal for the script
 *   half of the same problem.
 *
 * The numeric baseline lives in design-system-baseline.json.
 */
const ARBITRARY_COLOR_CLASS = String.raw`(?:bg|text|border|ring|fill|stroke|from|to|via|divide|outline|decoration|accent|caret|placeholder|shadow)-\[#[0-9a-fA-F]{3,8}\]`
const ARBITRARY_TEXT_SIZE_CLASS = String.raw`text-\[\d+(?:\.\d+)?px\]`
const ARBITRARY_RADIUS_CLASS = String.raw`rounded(?:-[trbl])?-\[\d+(?:\.\d+)?px\]`
const ABSOLUTE_TEXT_COLOR_CLASS = String.raw`(?<![\w:-])text-black(?![\w-])`

const DESIGN_SYSTEM_SELECTORS = [
    {
        selector: `Literal[value=/${ARBITRARY_COLOR_CLASS}/]`,
        message:
            'Arbitrary hex colour in a class string. Add a --color-* token under apps/desktop/src/styles/tokens/ and use it.',
    },
    {
        selector: `Literal[value=/${ARBITRARY_TEXT_SIZE_CLASS}/]`,
        message:
            'Arbitrary font size in a class string. Use a --text-* token or the Tailwind type scale.',
    },
    {
        selector: `Literal[value=/${ARBITRARY_RADIUS_CLASS}/]`,
        message: 'Arbitrary radius in a class string. Use a --radius-* token.',
    },
    {
        selector: `Literal[value=/${ABSOLUTE_TEXT_COLOR_CLASS}/]`,
        message:
            'text-black bypasses the text tokens. Use text-text-primary or another semantic token.',
    },
    {
        selector: `TemplateElement[value.raw=/${ARBITRARY_COLOR_CLASS}/]`,
        message:
            'Arbitrary hex colour in a template literal. Add a --color-* token under apps/desktop/src/styles/tokens/ and use it.',
    },
    {
        selector: `TemplateElement[value.raw=/${ARBITRARY_TEXT_SIZE_CLASS}/]`,
        message:
            'Arbitrary font size in a template literal. Use a --text-* token or the Tailwind type scale.',
    },
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
     * Design-system enforcement, phase 1.
     *
     * `components/ui/**` is zero-tolerance from day one: it is the layer every other
     * screen is supposed to build on, and at the time of writing it holds a single
     * file with two arbitrary values. Keeping the primitive layer clean is what makes
     * the rest of the migration possible.
     *
     * The rest of the tree is handled by the drift budget ratchet, which permits the
     * existing backlog to shrink but never grow. As files are cleaned they should be
     * removed from the exemption list below, and the list should reach zero.
     */
    {
        files: ['apps/desktop/src/components/ui/**/*.vue'],
        rules: {
            'no-restricted-syntax': ['error', ...DESIGN_SYSTEM_SELECTORS],
        },
    },
])

import eslint_js from '@eslint/js'
import { defineConfig, globalIgnores } from 'eslint/config'
import eslintPluginPrettierRecommended from 'eslint-plugin-prettier/recommended'
import simpleImportSort from 'eslint-plugin-simple-import-sort'
import eslint_vue from 'eslint-plugin-vue'
import globals from 'globals'
import * as eslint_ts from 'typescript-eslint'
import vue_parser from 'vue-eslint-parser'

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
])

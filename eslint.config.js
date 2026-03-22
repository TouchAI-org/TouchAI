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
    // 忽略文件
    globalIgnores(['node_modules', 'dist', 'build', 'src-tauri', '**/*d.ts','.worktrees']),
    // 推荐配置
    eslint_js.configs.recommended,
    ...eslint_ts.configs.recommended,
    ...eslint_vue.configs['flat/recommended'],
    // Prettier
    eslintPluginPrettierRecommended,
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

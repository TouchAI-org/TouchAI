import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

import * as ts from 'typescript';
import { describe, expect, it } from 'vitest';

const viteConfigSource = readFileSync(resolve(process.cwd(), 'vite.config.ts'), 'utf8');

const sourceFile = ts.createSourceFile(
    'vite.config.ts',
    viteConfigSource,
    ts.ScriptTarget.Latest,
    true,
    ts.ScriptKind.TS
);

function getPropertyNameText(name: ts.PropertyName) {
    if (ts.isIdentifier(name) || ts.isStringLiteral(name) || ts.isNumericLiteral(name)) {
        return name.text;
    }

    return undefined;
}

function findProperty(objectLiteral: ts.ObjectLiteralExpression, propertyName: string) {
    return objectLiteral.properties.find(
        (property): property is ts.PropertyAssignment =>
            ts.isPropertyAssignment(property) && getPropertyNameText(property.name) === propertyName
    );
}

function getObjectLiteralProperty(objectLiteral: ts.ObjectLiteralExpression, propertyName: string) {
    const property = findProperty(objectLiteral, propertyName);

    return property && ts.isObjectLiteralExpression(property.initializer)
        ? property.initializer
        : undefined;
}

function getStringArrayProperty(objectLiteral: ts.ObjectLiteralExpression, propertyName: string) {
    const property = findProperty(objectLiteral, propertyName);

    if (!property || !ts.isArrayLiteralExpression(property.initializer)) {
        return undefined;
    }

    return property.initializer.elements
        .filter((element): element is ts.StringLiteral => ts.isStringLiteral(element))
        .map((element) => element.text);
}

function getPropertyInitializerText(
    objectLiteral: ts.ObjectLiteralExpression,
    propertyName: string
) {
    const property = findProperty(objectLiteral, propertyName);

    return property?.initializer.getText(sourceFile);
}

function getViteConfigObject() {
    for (const statement of sourceFile.statements) {
        if (!ts.isExportAssignment(statement) || !ts.isCallExpression(statement.expression)) {
            continue;
        }

        const [configArgument] = statement.expression.arguments;
        if (configArgument && ts.isObjectLiteralExpression(configArgument)) {
            return configArgument;
        }
    }

    return undefined;
}

const viteConfigObject = getViteConfigObject();

if (!viteConfigObject) {
    throw new Error('Unable to find Vite defineConfig object');
}

const optimizeDepsInclude = getStringArrayProperty(
    getObjectLiteralProperty(viteConfigObject, 'optimizeDeps') ??
        ts.factory.createObjectLiteralExpression(),
    'include'
);
const vueDedupe = getStringArrayProperty(
    getObjectLiteralProperty(viteConfigObject, 'resolve') ??
        ts.factory.createObjectLiteralExpression(),
    'dedupe'
);
const cacheDir = getPropertyInitializerText(viteConfigObject, 'cacheDir');

describe('Vite dev dependency cache', () => {
    it('uses a worktree-local cache directory instead of shared node_modules cache', () => {
        expect(cacheDir).toBe("resolve(__dirname, '.vite-cache')");
    });

    it('dedupes Vue across junctioned worktrees', () => {
        expect(vueDedupe).toEqual(['vue']);
    });

    it('pre-optimizes lazy settings tab dependencies', () => {
        expect(optimizeDepsInclude).toBeDefined();

        for (const dependency of [
            '@tauri-apps/api/app',
            '@tauri-apps/api/core',
            '@tauri-apps/api/event',
            '@tauri-apps/api/path',
            '@tauri-apps/api/webviewWindow',
            '@tauri-apps/api/window',
            '@tauri-apps/plugin-dialog',
            '@tauri-apps/plugin-deep-link',
            '@tauri-apps/plugin-fs',
            '@tauri-apps/plugin-http',
            '@tauri-apps/plugin-notification',
            '@tauri-apps/plugin-opener',
            '@tauri-apps/plugin-process',
            'katex',
            'mermaid',
            'pinia',
            'reka-ui',
            'vue',
            'vue-router',
            'vue-sonner',
        ]) {
            expect(optimizeDepsInclude).toContain(dependency);
        }
    });
});

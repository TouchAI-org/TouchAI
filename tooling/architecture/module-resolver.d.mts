import type ts from 'typescript';

export type ResolverClassification = 'local' | 'external' | 'asset' | 'unresolved-local';

export type ModuleResolution = {
    classification: ResolverClassification;
    absolute: string | null;
    virtual: boolean;
    package: string | null;
    packageName: string | null;
    configPath: string;
};

export type ModuleResolver = {
    projectRoot: string;
    srcRoot: string;
    configPath: string;
    compilerOptions: ts.CompilerOptions;
    resolve(specifier: string, importerAbsolute: string): ModuleResolution;
    expandGlob(specifier: string, importerAbsolute: string): string[];
};

export function readProjectCompilerOptions(projectRoot: string): {
    configPath: string;
    compilerOptions: ts.CompilerOptions;
};

export function createModuleResolver(
    projectRoot: string,
    options?: { srcRoot?: string }
): ModuleResolver;

import type { ModuleResolver } from './module-resolver.d.mts';

export type ImportKind = 'value' | 'type' | 'dynamic';

export type ImportEdge = {
    specifier: string;
    kind: ImportKind;
    bindings: string[];
    line: number;
};

export type UnresolvedDynamicImport = { line: number };
export type ImportGlob = {
    patterns: string[];
    form: 'glob' | 'globEager';
    line: number;
};
export type UnresolvedLocalImport = {
    importer: string;
    specifier: string;
    line: number;
};

export type GraphNode = {
    id: string;
    srcRel: string | null;
    absolute: string | null;
    external: boolean;
    virtual: boolean;
    package?: string;
    packageName?: string | null;
};

export type GraphEdge = {
    from: string;
    to: string;
    specifier: string;
    kind: ImportKind;
    bindings: string[];
    line: number;
};

export type ModuleGraph = {
    resolver: ModuleResolver;
    files: string[];
    nodes: Map<string, GraphNode>;
    adjacency: Map<string, GraphEdge[]>;
    parseErrors: { file: string; message: string }[];
    sourceErrors: { importer: string; message: string }[];
    unresolvedLocal: UnresolvedLocalImport[];
    unresolvedDynamic: { importer: string; line: number }[];
};

export const SOURCE_EXTENSIONS: string[];
export const DECLARATION_EXTENSIONS: string[];

export function isArchitectureSourceFile(filename: string): boolean;
export function importDeclarationKind(node: unknown): ImportKind;
export function exportDeclarationKind(node: unknown): ImportKind;
export function importTypeSpecifier(node: unknown): string | null;
export function importMetaGlobForm(node: unknown): 'glob' | 'globEager' | null;
export function literalGlobPatterns(node: unknown): string[] | null;
export function collectImportGraph(
    code: string,
    filename: string
): {
    edges: ImportEdge[];
    globs: ImportGlob[];
    unresolved: UnresolvedDynamicImport[];
};
export function collectImports(code: string, filename: string): ImportEdge[];
export function validateSourceRoot(srcRoot: string): void;
export function listSourceFiles(root: string): string[];
export function describeSource(
    absolute: string,
    roots: { projectRoot: string; srcRoot: string }
): { absolute: string; repoRel: string; srcRel: string | null };
export function buildModuleGraph(options: { projectRoot: string; srcRoot: string }): ModuleGraph;

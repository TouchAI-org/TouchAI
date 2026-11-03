import type { ImportKind } from './boundaries.d.mts';

export type ImportEdge = { specifier: string; kind: ImportKind };

export type UnresolvedDynamicImport = { file: string; line: number };

export type CycleAnalysis = {
    fileCount: number;
    parseErrors: { file: string; message: string }[];
    unresolvedDynamic: UnresolvedDynamicImport[];
    runtimeCycles: string[][];
    newRuntimeCycles: string[][];
    baselinedCount: number;
    typeOnlyCycles: string[][];
};

export function collectImports(code: string, filename: string): ImportEdge[];

export function listSourceFiles(root: string): string[];

export function analyzeCycles(options?: { projectRoot?: string; srcRoot?: string }): CycleAnalysis;

export function formatReport(result: CycleAnalysis): string;

export function parseCliArgs(argv: string[]): {
    projectRoot: string;
    srcRoot: string;
    json: boolean;
};

import type { Linter } from 'eslint';

export type ArchitectureLayer = 'ui' | 'ui-state' | 'services' | 'data' | 'support' | 'external';

export type TargetDescription = {
    absolute: string;
    repoRel: string;
    srcRel: string | null;
    isVue: boolean;
    layer: string;
};

export type AliasMap = {
    baseUrl: string;
    paths: Record<string, string[]>;
};

export type ImportKind = 'value' | 'type' | 'dynamic';

export type BoundaryRule = {
    id: string;
    importer: (srcRel: string) => boolean;
    forbidden: (target: TargetDescription, importerSrcRel: string) => boolean;
    kinds: ImportKind[];
};

export type ArchitectureConfigOptions = {
    projectRoot?: string;
    srcRoot?: string;
    aliases?: AliasMap;
    files?: string[];
    globPrefix?: string;
    serviceFiles?: string[];
};

export const PROJECT_ROOT: string;
export const SRC_ROOT: string;
export const SOURCE_EXTENSIONS: string[];
export const DECLARATION_FILE_GLOBS: string[];
export const SOURCE_FILE_GLOB: string;
export const SOURCE_FILE_PATTERNS: string[];
export const SOURCE_FILES: string[];
export const HOST_ADAPTERS: { file: string; reason: string; exit: string; issue: string }[];
export const RUNTIME_UI_PACKAGES: string[];
export const IMPORT_BOUNDARY_RULES: BoundaryRule[];

export function layerOf(srcRel: string): string;
export function isUnder(value: string, prefix: string): boolean;
export function importTypeSpecifier(node: unknown): string | null;
export function isArchitectureSourceFile(filename: string): boolean;

export function describeTarget(
    absolutePath: string,
    roots?: { projectRoot?: string; srcRoot?: string }
): TargetDescription;

export function resolveToAbsolute(
    specifier: string,
    importerAbsolute: string,
    aliases?: AliasMap
): string | null;

export function importDeclarationKind(node: unknown): ImportKind;

export function createArchitectureConfig(options?: ArchitectureConfigOptions): Linter.Config[];

export const architectureConfig: Linter.Config[];

export const architecturePlugin: unknown;

export function createStandaloneConfig(options?: ArchitectureConfigOptions): Linter.Config[];

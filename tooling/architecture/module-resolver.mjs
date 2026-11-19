// Copyright (c) 2026. Qian Cheng. Licensed under GPL v3

import fs from 'node:fs';
import path from 'node:path';

import ts from 'typescript';

const SOURCE_EXTENSIONS = [
    '.d.ts',
    '.d.mts',
    '.d.cts',
    '.vue',
    '.tsx',
    '.mts',
    '.cts',
    '.ts',
    '.jsx',
    '.mjs',
    '.cjs',
    '.js',
];

const VITE_QUERY_PATTERN = /[?#].*$/;

function toPosixPath(value) {
    return value.split(path.sep).join('/');
}

function isDirectory(candidate) {
    try {
        return fs.statSync(candidate).isDirectory();
    } catch {
        return false;
    }
}

function isReadableFile(candidate) {
    try {
        fs.accessSync(candidate, fs.constants.R_OK);
        return fs.statSync(candidate).isFile();
    } catch {
        return false;
    }
}

function findConfigFile(projectRoot) {
    const candidates = [
        path.join(projectRoot, 'apps/desktop/tsconfig.json'),
        path.join(projectRoot, 'tsconfig.json'),
    ];
    const configPath = candidates.find(isReadableFile);
    if (configPath === undefined) {
        throw new Error(
            `[invalid-project-root] ${projectRoot} has no readable apps/desktop/tsconfig.json or tsconfig.json`
        );
    }
    return configPath;
}

function formatDiagnostics(diagnostics) {
    return ts.formatDiagnosticsWithColorAndContext(diagnostics, {
        getCanonicalFileName: (fileName) => fileName,
        getCurrentDirectory: () => process.cwd(),
        getNewLine: () => '\n',
    });
}

export function readProjectCompilerOptions(projectRoot) {
    const absoluteRoot = path.resolve(projectRoot);
    if (!isDirectory(absoluteRoot)) {
        throw new Error(`[invalid-project-root] ${absoluteRoot} is not a readable directory`);
    }

    const configPath = findConfigFile(absoluteRoot);
    /** @type {ts.Diagnostic[]} */
    const diagnostics = [];
    const host = {
        ...ts.sys,
        onUnRecoverableConfigFileDiagnostic(diagnostic) {
            diagnostics.push(diagnostic);
        },
    };
    const parsed = ts.getParsedCommandLineOfConfigFile(configPath, {}, host);
    if (parsed === undefined) {
        throw new Error(`[invalid-tsconfig] ${configPath} could not be parsed`);
    }
    const allDiagnostics = [...diagnostics, ...parsed.errors];
    if (allDiagnostics.length > 0) {
        throw new Error(
            `[invalid-tsconfig] ${configPath}\n${formatDiagnostics(allDiagnostics)}`.trimEnd()
        );
    }

    return {
        configPath,
        compilerOptions: {
            ...parsed.options,
            noEmit: true,
        },
    };
}

function sourceExtensionOf(candidate) {
    return SOURCE_EXTENSIONS.find((extension) => candidate.endsWith(extension)) ?? null;
}

function stripTypeScriptExtension(candidate) {
    const extension = sourceExtensionOf(candidate);
    return extension === null ? candidate : candidate.slice(0, -extension.length);
}

function explicitFileCandidates(failedLookupLocations, cleanSpecifier) {
    const candidates = new Set();
    const expectsVue = cleanSpecifier.endsWith('.vue');
    const explicitExtension = path.extname(cleanSpecifier);

    for (const lookup of failedLookupLocations ?? []) {
        const withoutQuery = lookup.replace(VITE_QUERY_PATTERN, '');
        const base = stripTypeScriptExtension(withoutQuery);
        candidates.add(base);
        for (const extension of SOURCE_EXTENSIONS) candidates.add(`${base}${extension}`);
        if (base.endsWith('.d.vue')) candidates.add(base.slice(0, -'.d.vue'.length) + '.vue');
        if (base.endsWith('.d')) candidates.add(base.slice(0, -2));
        if (expectsVue && !base.endsWith('.vue')) candidates.add(`${base}.vue`);
        if (explicitExtension !== '' && base.endsWith(`.d${explicitExtension}`)) {
            candidates.add(base.slice(0, -`.d${explicitExtension}`.length) + explicitExtension);
        }
    }

    return [...candidates].filter(isReadableFile);
}

function isNodeModulesPath(candidate) {
    return toPosixPath(candidate).split('/').includes('node_modules');
}

function isPathLikeSpecifier(specifier) {
    return (
        specifier.startsWith('./') ||
        specifier.startsWith('../') ||
        specifier.startsWith('/') ||
        specifier === '.' ||
        specifier === '..'
    );
}

function isViteVirtualSpecifier(specifier) {
    return (
        specifier.startsWith('virtual:') ||
        specifier.startsWith('vite:') ||
        specifier.startsWith('\0') ||
        specifier.startsWith('@vite/client') ||
        specifier.startsWith('/@vite/')
    );
}

function packageNameOfSpecifier(specifier) {
    const segments = specifier.split('/');
    if (specifier.startsWith('@') && segments.length >= 2) {
        return `${segments[0]}/${segments[1]}`;
    }
    return segments[0] ?? specifier;
}

function classifyResolvedPath(absolute, srcRoot) {
    const normalized = path.resolve(absolute);
    const relativeToSrc = path.relative(srcRoot, normalized);
    const insideSrc =
        relativeToSrc === '' ||
        (!relativeToSrc.startsWith('..') && !path.isAbsolute(relativeToSrc));
    if (isNodeModulesPath(normalized)) return 'external';
    if (sourceExtensionOf(normalized) === null) return 'asset';
    return insideSrc ? 'local' : 'unresolved-local';
}

export function createModuleResolver(projectRoot, { srcRoot } = {}) {
    const absoluteProjectRoot = path.resolve(projectRoot);
    const absoluteSrcRoot = path.resolve(srcRoot ?? path.join(absoluteProjectRoot, 'src'));
    if (!isDirectory(absoluteProjectRoot)) {
        throw new Error(
            `[invalid-project-root] ${absoluteProjectRoot} is not a readable directory`
        );
    }
    if (!isDirectory(absoluteSrcRoot)) {
        throw new Error(`[invalid-source-root] ${absoluteSrcRoot} is not a readable directory`);
    }

    const { configPath, compilerOptions } = readProjectCompilerOptions(absoluteProjectRoot);
    const parsedPathPatterns = ts.tryParsePatterns(compilerOptions.paths ?? {});
    const moduleResolutionCache = ts.createModuleResolutionCache(
        absoluteProjectRoot,
        (fileName) => fileName,
        compilerOptions
    );
    const configDirectory = path.dirname(configPath);
    const pathBase = compilerOptions.baseUrl
        ? path.resolve(configDirectory, compilerOptions.baseUrl)
        : configDirectory;

    function matchPathAlias(specifier) {
        const matched = ts.matchPatternOrExact(parsedPathPatterns, specifier);
        if (matched === undefined) return null;
        if (typeof matched === 'string') {
            return {
                targets: compilerOptions.paths?.[matched],
                remainder: '',
            };
        }
        const alias = `${matched.prefix}*${matched.suffix}`;
        return {
            targets: compilerOptions.paths?.[alias],
            remainder: specifier.slice(
                matched.prefix.length,
                specifier.length - matched.suffix.length
            ),
        };
    }

    function resolve(specifier, importerAbsolute) {
        if (typeof specifier !== 'string' || specifier.length === 0) {
            throw new Error(`[invalid-specifier] expected a non-empty module specifier`);
        }

        const virtualSuffix = VITE_QUERY_PATTERN.test(specifier);
        const cleanSpecifier = specifier.replace(VITE_QUERY_PATTERN, '');
        const resolution = ts.resolveModuleName(
            cleanSpecifier,
            path.resolve(importerAbsolute),
            compilerOptions,
            ts.sys,
            moduleResolutionCache
        );

        if (resolution.resolvedModule !== undefined) {
            const absolute = path.resolve(resolution.resolvedModule.resolvedFileName);
            const classification = classifyResolvedPath(absolute, absoluteSrcRoot);
            const packageName =
                classification === 'external'
                    ? (resolution.resolvedModule.packageId?.name ??
                      packageNameOfSpecifier(cleanSpecifier))
                    : null;
            return {
                classification,
                absolute: classification === 'local' ? absolute : null,
                virtual: virtualSuffix,
                package: classification === 'external' ? cleanSpecifier : null,
                packageName,
                configPath,
            };
        }

        const explicitCandidates = explicitFileCandidates(
            resolution.failedLookupLocations,
            cleanSpecifier
        );
        if (explicitCandidates.length > 0) {
            const absolute = path.resolve(explicitCandidates[0]);
            const classification = classifyResolvedPath(absolute, absoluteSrcRoot);
            return {
                classification,
                absolute: classification === 'local' ? absolute : null,
                virtual: virtualSuffix,
                package: classification === 'external' ? cleanSpecifier : null,
                packageName:
                    classification === 'external' ? packageNameOfSpecifier(cleanSpecifier) : null,
                configPath,
            };
        }

        if (isViteVirtualSpecifier(cleanSpecifier) || isViteVirtualSpecifier(specifier)) {
            return {
                classification: 'external',
                absolute: null,
                virtual: true,
                package: cleanSpecifier,
                packageName: packageNameOfSpecifier(cleanSpecifier),
                configPath,
            };
        }

        const local =
            isPathLikeSpecifier(cleanSpecifier) ||
            ts.matchPatternOrExact(parsedPathPatterns, cleanSpecifier) !== undefined;
        return {
            classification: local ? 'unresolved-local' : 'external',
            absolute: null,
            virtual: virtualSuffix,
            package: local ? null : cleanSpecifier,
            packageName: local ? null : packageNameOfSpecifier(cleanSpecifier),
            configPath,
        };
    }

    function globPatternsFor(specifier, importerAbsolute) {
        if (specifier.trim() === '' || specifier.startsWith('!')) {
            throw new Error(`[unsupported-glob-pattern] ${specifier || '<empty>'}`);
        }

        if (specifier.startsWith('/')) {
            return [path.resolve(configDirectory, specifier.slice(1))];
        }
        if (isPathLikeSpecifier(specifier)) {
            return [path.resolve(path.dirname(path.resolve(importerAbsolute)), specifier)];
        }

        const alias = matchPathAlias(specifier);
        if (alias === null) {
            throw new Error(
                `[unresolved-glob-pattern] ${specifier} has no matching tsconfig alias`
            );
        }
        if (!Array.isArray(alias.targets) || alias.targets.length === 0) {
            throw new Error(`[invalid-glob-alias] ${specifier} has no alias targets`);
        }
        return alias.targets.map((target) =>
            path.resolve(pathBase, target.replace('*', alias.remainder))
        );
    }

    function expandGlob(specifier, importerAbsolute) {
        const matches = new Set();
        for (const globPattern of globPatternsFor(specifier, importerAbsolute)) {
            let candidates;
            try {
                const normalizedPattern = toPosixPath(path.resolve(globPattern));
                const wildcardIndex = normalizedPattern.search(/[*?[\]{}]/);
                const staticPrefix =
                    wildcardIndex === -1
                        ? path.dirname(normalizedPattern)
                        : normalizedPattern.slice(0, wildcardIndex);
                const searchRoot = staticPrefix.endsWith('/')
                    ? path.resolve(staticPrefix)
                    : path.dirname(staticPrefix);
                const relativeToSrc = path.relative(absoluteSrcRoot, searchRoot);
                if (relativeToSrc.startsWith('..') || path.isAbsolute(relativeToSrc)) {
                    throw new Error(
                        `[glob-outside-source-root] ${specifier} starts outside ${absoluteSrcRoot}`
                    );
                }
                candidates = ts.sys.readDirectory(searchRoot, undefined, undefined, [
                    normalizedPattern,
                ]);
            } catch (error) {
                throw new Error(`[invalid-glob-pattern] ${specifier}: ${error.message}`, {
                    cause: error,
                });
            }
            for (const candidate of candidates) {
                const absolute = path.resolve(candidate);
                if (!isReadableFile(absolute)) continue;
                const relativeToSrc = path.relative(absoluteSrcRoot, absolute);
                if (relativeToSrc.startsWith('..') || path.isAbsolute(relativeToSrc)) {
                    throw new Error(
                        `[glob-outside-source-root] ${specifier} matched ${absolute}, outside ${absoluteSrcRoot}`
                    );
                }
                matches.add(absolute);
            }
        }
        return [...matches].sort();
    }

    return {
        projectRoot: absoluteProjectRoot,
        srcRoot: absoluteSrcRoot,
        configPath,
        compilerOptions,
        resolve,
        expandGlob,
    };
}

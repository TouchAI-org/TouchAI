import fs from 'node:fs';
import { isBuiltin } from 'node:module';
import path from 'node:path';
import process from 'node:process';
import { fileURLToPath } from 'node:url';

import { buildModuleGraph } from './module-graph.mjs';

const PROJECT_ROOT = fileURLToPath(new URL('../../', import.meta.url));
const PACKAGES = new Set(['agent-core', 'models']);
const PROVIDERS = new Set([
    'openai',
    'openai-compatible',
    'anthropic',
    'anthropic-compatible',
    'google',
    'deepseek',
    'xai',
    'moonshot',
    'alibaba',
    'minimax',
    'zhipu',
    'mimo',
]);
const DESKTOP = 'apps/desktop/src/';
const PRESENTATION = new Set(['views', 'components', 'stores', 'composables', 'router']);
const FRAMEWORKS = new Set(['vue', 'pinia', 'vue-router', 'vue-i18n', 'reka-ui', 'vue-sonner']);
const I_O_LIBRARIES = new Set(['drizzle-orm', 'tauri-plugin-fs-pro-api']);
const MAIN_ASSEMBLY = `${DESKTOP}app/composition/main.ts`;
const NON_PRODUCTION = new Set(['test', 'tooling']);
const PRESENTATION_ROLES = new Set(['ui', 'presentation-support']);
const API_DEPENDENCIES = new Set(['vue', 'vue-i18n', 'zod', 'semver', 'markstream-vue']);
const API_PLATFORM_BINDINGS = {
    'app/api/agent/events.ts': {
        'platform/windows/events.ts': ['createWindowEvents'],
    },
    'app/api/attachments/presentation.ts': {
        'platform/files/index.ts': ['convertFileSrc'],
    },
    'app/api/diagnostics/attributes.ts': {
        'platform/diagnostics/attributes.ts': ['ATTR'],
    },
    'app/api/diagnostics/index.ts': {
        'platform/diagnostics/index.ts': ['error', 'event', 'log'],
    },
    'app/api/models/selection.ts': {
        'platform/windows/events.ts': ['createWindowEvent'],
    },
    'app/api/search/events.ts': {
        'platform/windows/events.ts': ['createWindowEvents'],
    },
    'app/api/settings/events.ts': {
        'platform/windows/events.ts': ['createWindowEvents'],
    },
    'app/api/tools/computerDirectory.ts': {
        'platform/windows/dialog.ts': ['pickDirectory'],
    },
    'app/api/tools/events.ts': {
        'platform/windows/events.ts': ['createWindowEvents'],
    },
    'app/api/usage/events.ts': {
        'platform/windows/events.ts': ['createWindowEvents'],
    },
    'app/api/windows/clipboard.ts': {
        'platform/native/clipboard.ts': ['clipboard'],
    },
    'app/api/windows/external.ts': {
        'platform/windows/external.ts': ['openUrl'],
    },
    'app/api/windows/notifications.ts': {
        'platform/windows/notifications.ts': [
            'sendWindowNotification',
            'initNotificationPermission',
        ],
    },
    'app/api/windows/runtime.ts': {
        'platform/native/runtimeMode.ts': ['isE2eTestMode'],
        'platform/windows/execution.ts': ['getNativeWindowLabel'],
    },
};

function isApiPlatformBinding(edge) {
    const bindings = API_PLATFORM_BINDINGS[sourceRole(edge.from).path]?.[sourceRole(edge.to).path];
    return (
        bindings !== undefined &&
        edge.kind !== 'dynamic' &&
        edge.bindings.length > 0 &&
        edge.bindings.every((binding) => bindings.includes(binding))
    );
}

function sourceRole(id) {
    const packageTest = /^packages\/([^/]+)\/tests\//.exec(id);
    if (packageTest) return { kind: 'test', package: packageTest[1], path: id };
    if (/^(?:tests\/|apps\/[^/]+\/(?:tests|e2e-tests)\/)/.test(id))
        return { kind: 'test', path: id };
    const pkg = /^packages\/([^/]+)\/src\/(.*)$/.exec(id);
    if (pkg) return { kind: 'package', package: pkg[1], path: pkg[2] };
    if (id.startsWith('apps/site/src/')) return { kind: 'site', path: id };
    if (!id.startsWith(DESKTOP)) return { kind: 'tooling', path: id };
    const relative = id.slice(DESKTOP.length);
    const module = /^modules\/([^/]+)\/(.*)$/.exec(relative);
    if (module)
        return {
            kind: 'module',
            module: module[1],
            path: module[2],
            io: module[2].startsWith('io/') || /\.io\.[cm]?[jt]s$/.test(module[2]),
        };
    const area = relative.split('/')[0];
    if (relative === 'main.ts') return { kind: 'bootstrap', path: relative };
    if (area === 'i18n' || relative === 'vite-env.d.ts')
        return { kind: 'presentation-support', path: relative };
    if (PRESENTATION.has(area) || relative === 'App.vue') return { kind: 'ui', path: relative };
    if (relative.startsWith('app/api/')) return { kind: 'api', path: relative };
    if (relative.startsWith('app/composition/')) return { kind: 'composition', path: relative };
    if (relative.startsWith('app/workflows/')) return { kind: 'workflow', path: relative };
    if (relative.startsWith('app/bootstrap/')) return { kind: 'bootstrap', path: relative };
    if (area === 'adapters') return { kind: 'adapter', path: relative };
    if (area === 'platform' || area === 'database') return { kind: area, path: relative };
    if (area === 'services' || area === 'domain') return { kind: 'legacy', path: relative };
    return { kind: 'neutral', path: relative };
}

function packageEntry(id, pkg) {
    if (pkg === 'agent-core') return ['src/index.ts', 'src/contracts/index.ts'].includes(id);
    if (pkg !== 'models') return false;
    if (['src/index.ts', 'src/contracts/index.ts', 'src/catalog/index.ts'].includes(id))
        return true;
    const provider = /^src\/providers\/([^/]+)\.ts$/.exec(id);
    return provider !== null && PROVIDERS.has(provider[1]);
}

function neutralModelsPath(value) {
    return (
        /^(contracts|catalog)\//.test(value) ||
        ['encoding/json.ts', 'encoding/reasoning/openaiModels.ts'].includes(value)
    );
}

function publicModulePath(value) {
    return /^(?:index|public|create|contracts)\.(?:ts|mts|cts)$/.test(value);
}

function moduleCapabilityEntry(value) {
    return /^(?:index|public|create)\.(?:ts|mts|cts)$/.test(value);
}

function constrained(role) {
    return [
        'package',
        'module',
        'ui',
        'api',
        'composition',
        'workflow',
        'adapter',
        'platform',
        'database',
        'bootstrap',
        'legacy',
        'neutral',
        'presentation-support',
    ].includes(role.kind);
}

function isSystemPackage(node) {
    return node.packageName?.startsWith('@tauri-apps/') || I_O_LIBRARIES.has(node.packageName);
}

function inspectDependency(origin, target, node, neutralDependencyRoles) {
    const neutralModels =
        origin.kind === 'package' &&
        origin.package === 'models' &&
        /^(contracts|catalog)\//.test(origin.path);
    if (!node.external && NON_PRODUCTION.has(target.kind)) return 'nonproduction-dependency';
    if (node.external) {
        const system = isSystemPackage(node);
        const importedPackage = node.package?.match(/^@[^/]+\/[^/]+|^[^/]+/)?.[0];
        if (origin.kind === 'api' && !API_DEPENDENCIES.has(importedPackage)) return 'api-authority';
        // Neutral dependencies are positively owned in the package manifest, not
        // inferred from a parallel list of known provider SDK brands.
        const neutralDependencies = neutralDependencyRoles.get(origin.package);
        if (neutralModels && !neutralDependencies?.has(node.packageName))
            return 'neutral-model-entry';
        if (
            origin.kind === 'package' &&
            origin.package === 'agent-core' &&
            !neutralDependencies?.has(node.packageName)
        )
            return 'package-dependency';
        if (
            origin.kind === 'package' &&
            (system ||
                FRAMEWORKS.has(node.packageName) ||
                isBuiltin(node.package ?? node.packageName ?? ''))
        )
            return 'package-dependency';
        if (origin.kind === 'module' && FRAMEWORKS.has(node.packageName)) return 'module-framework';
        if (
            origin.kind === 'module' &&
            (system || isBuiltin(node.package ?? node.packageName ?? ''))
        )
            return 'module-io';
        if (
            origin.kind === 'neutral' &&
            (system ||
                FRAMEWORKS.has(node.packageName) ||
                isBuiltin(node.package ?? node.packageName ?? ''))
        )
            return 'neutral-boundary';
        if (PRESENTATION_ROLES.has(origin.kind) && system) return 'ui-boundary';
        if (['database', 'platform'].includes(origin.kind) && FRAMEWORKS.has(node.packageName))
            return 'platform-boundary';
        return null;
    }
    if (origin.kind === 'package') {
        if (target.kind !== 'package') return 'package-dependency';
        if (neutralModels && target.package === 'models' && !neutralModelsPath(target.path))
            return 'neutral-model-entry';
        if (origin.package === 'models' && target.package !== 'models') return 'package-dependency';
        if (
            origin.package === 'agent-core' &&
            target.package !== 'agent-core' &&
            !(target.package === 'models' && target.path.startsWith('contracts/'))
        )
            return 'package-dependency';
    }
    if (origin.kind === 'module') {
        if (target.kind === 'module' && origin.module !== target.module) return 'cross-module';
        if (
            [
                'ui',
                'presentation-support',
                'api',
                'workflow',
                'composition',
                'bootstrap',
                'adapter',
                'legacy',
            ].includes(target.kind)
        )
            return 'module-boundary';
        if (!origin.io && ['database', 'platform'].includes(target.kind)) return 'module-io';
        if (
            target.kind === 'package' &&
            target.package === 'agent-core' &&
            origin.module !== 'agent'
        )
            return 'module-boundary';
    }
    if (
        PRESENTATION_ROLES.has(origin.kind) &&
        [
            'module',
            'database',
            'platform',
            'adapter',
            'composition',
            'workflow',
            'bootstrap',
            'legacy',
        ].includes(target.kind)
    )
        return 'ui-boundary';
    if (
        origin.kind === 'neutral' &&
        [
            'module',
            'database',
            'platform',
            'adapter',
            'composition',
            'workflow',
            'api',
            'bootstrap',
            'ui',
            'presentation-support',
            'legacy',
        ].includes(target.kind)
    )
        return 'neutral-boundary';
    if (
        PRESENTATION_ROLES.has(origin.kind) &&
        target.kind === 'package' &&
        !target.path.startsWith('contracts/') &&
        !(target.package === 'models' && neutralModelsPath(target.path))
    )
        return 'ui-boundary';
    if (
        origin.kind === 'api' &&
        target.kind === 'module' &&
        !/^(?:public|contracts)\.(?:ts|mts|cts)$/.test(target.path)
    )
        return 'module-role-entry';
    if (
        origin.kind === 'api' &&
        (['composition', 'bootstrap', 'adapter', 'database', 'platform', 'ui'].includes(
            target.kind
        ) ||
            (target.kind === 'workflow' && !target.path.endsWith('/contracts.ts')) ||
            (target.kind === 'package' &&
                !target.path.startsWith('contracts/') &&
                !(target.package === 'models' && neutralModelsPath(target.path))))
    )
        return 'api-authority';
    if (
        ['workflow', 'adapter'].includes(origin.kind) &&
        ['ui', 'bootstrap', 'composition'].includes(target.kind)
    )
        return 'orchestration-boundary';
    if (
        ['platform', 'database'].includes(origin.kind) &&
        [
            'module',
            'ui',
            'presentation-support',
            'api',
            'workflow',
            'composition',
            'bootstrap',
            'adapter',
            'legacy',
        ].includes(target.kind)
    )
        return 'platform-boundary';
    if (
        ['workflow', 'composition', 'adapter', 'api', 'bootstrap'].includes(origin.kind) &&
        target.kind === 'module' &&
        !publicModulePath(target.path)
    )
        return 'module-entry';
    return null;
}

function runtimeCycles(graph) {
    let serial = 0;
    const indexes = new Map();
    const low = new Map();
    const stack = [];
    const active = new Set();
    const cycles = [];
    const visit = (id) => {
        indexes.set(id, serial);
        low.set(id, serial++);
        stack.push(id);
        active.add(id);
        const edges = (graph.adjacency.get(id) ?? []).filter(
            (edge) => edge.kind !== 'type' && !graph.nodes.get(edge.to)?.external
        );
        for (const edge of edges) {
            if (!indexes.has(edge.to)) {
                visit(edge.to);
                low.set(id, Math.min(low.get(id), low.get(edge.to)));
            } else if (active.has(edge.to))
                low.set(id, Math.min(low.get(id), indexes.get(edge.to)));
        }
        if (low.get(id) !== indexes.get(id)) return;
        const component = [];
        let member;
        do {
            member = stack.pop();
            active.delete(member);
            component.push(member);
        } while (member !== id);
        if (component.length > 1 || edges.some((edge) => edge.to === id))
            cycles.push(component.sort());
    };
    for (const node of graph.nodes.values())
        if (!node.external && !indexes.has(node.id)) visit(node.id);
    return cycles.sort((left, right) => left.join('|').localeCompare(right.join('|')));
}

/** Role checks follow helpers and reexports until an explicitly permitted capability boundary. */
export function analyzeRepository({ projectRoot = PROJECT_ROOT } = {}) {
    projectRoot = path.resolve(projectRoot);
    const graph = buildModuleGraph({ projectRoot, srcRoot: projectRoot });
    for (const sourceRoot of [
        `${DESKTOP.slice(0, -1)}`,
        'packages/agent-core/src',
        'packages/models/src',
    ]) {
        if (
            !graph.files.some((file) =>
                file.startsWith(`${path.join(projectRoot, sourceRoot)}${path.sep}`)
            )
        ) {
            throw new Error(
                `[invalid-source-root] ${sourceRoot} is missing or has no source files`
            );
        }
    }
    const violations = [];
    const seen = new Set();
    const neutralDependencyRoles = new Map();
    for (const pkg of PACKAGES) {
        const manifestPath = path.join(projectRoot, 'packages', pkg, 'package.json');
        const manifest = fs.existsSync(manifestPath)
            ? JSON.parse(fs.readFileSync(manifestPath, 'utf8'))
            : {};
        const declared = manifest.touchaiArchitecture?.neutralDependencies ?? [];
        if (
            !Array.isArray(declared) ||
            declared.some((dependency) => typeof dependency !== 'string' || !dependency.trim())
        ) {
            throw new Error(
                `[invalid-dependency-role] ${pkg} neutralDependencies must be an array of package names`
            );
        }
        const neutralDependencies = new Set(declared);
        for (const dependency of neutralDependencies) {
            if (
                !Object.hasOwn(manifest.dependencies ?? {}, dependency) ||
                dependency.startsWith('@touchai/')
            ) {
                throw new Error(
                    `[invalid-dependency-role] neutral dependency ${dependency} is not a permitted ${pkg} external dependency`
                );
            }
        }
        neutralDependencyRoles.set(pkg, neutralDependencies);
    }
    const report = (code, from, to, edge, chain) => {
        const key = `${code}|${from}|${to}|${edge?.line ?? 0}`;
        if (seen.has(key)) return;
        seen.add(key);
        violations.push({ code, from, to, line: edge?.line ?? 0, chain });
    };

    const packageDirectory = path.join(projectRoot, 'packages');
    if (fs.existsSync(packageDirectory)) {
        for (const entry of fs.readdirSync(packageDirectory, { withFileTypes: true })) {
            if (entry.isDirectory() && !PACKAGES.has(entry.name))
                report('unexpected-business-package', `packages/${entry.name}`, null, null, []);
        }
    }

    for (const [id, edges] of graph.adjacency) {
        const origin = sourceRole(id);
        if (origin.kind === 'legacy') report('legacy-path', id, null, null, []);
        for (const edge of edges) {
            const target = graph.nodes.get(edge.to);
            if (!target) continue;
            const role = sourceRole(edge.to);
            if (
                role.kind === 'package' &&
                role.package === 'agent-core' &&
                role.path === 'index.ts' &&
                edge.kind !== 'type' &&
                !(origin.kind === 'package' && origin.package === 'agent-core') &&
                origin.kind !== 'test' &&
                id !== MAIN_ASSEMBLY
            )
                report('execution-host-entry', id, edge.to, edge, [id, edge.to]);
            const specifier = /^@touchai\/(agent-core|models)(?:\/(.*))?$/.exec(edge.specifier);
            if (specifier) {
                const suffix = specifier[2];
                const allowed =
                    suffix === undefined ||
                    suffix === 'contracts' ||
                    (specifier[1] === 'models' &&
                        (suffix === 'catalog' ||
                            (/^providers\/[^/]+$/.test(suffix) &&
                                PROVIDERS.has(suffix.slice('providers/'.length)))));
                if (!allowed) report('package-entry', id, edge.to, edge, [id, edge.to]);
            }
            if (
                !target.external &&
                role.kind === 'package' &&
                !(['package', 'test'].includes(origin.kind) && origin.package === role.package) &&
                !packageEntry(`src/${role.path}`, role.package)
            )
                report('package-entry', id, edge.to, edge, [id, edge.to]);
            const tauriEntry = target.package?.replace(/[?#].*$/, '');
            const invokeBinding =
                tauriEntry === '@tauri-apps/api/core'
                    ? 'invoke'
                    : ['@tauri-apps/api', '@tauri-apps/api/index'].includes(tauriEntry)
                      ? 'core'
                      : null;
            if (
                target.external &&
                target.packageName === '@tauri-apps/api' &&
                invokeBinding !== null &&
                edge.bindings.some((binding) => binding === invokeBinding || binding === '*') &&
                !NON_PRODUCTION.has(origin.kind) &&
                id !== `${DESKTOP}platform/native/invoke.ts`
            )
                report('raw-native-invoke', id, edge.to, edge, [id, edge.to]);
        }
        if (!constrained(origin)) continue;
        const visited = new Set([id]);
        const queue = edges.map((edge) => ({ edge, chain: [id, edge.to] }));
        for (let index = 0; index < queue.length; index++) {
            const { edge, chain } = queue[index];
            const node = graph.nodes.get(edge.to);
            if (!node) continue;
            const target = sourceRole(edge.to);
            if (origin.kind === 'api' && target.kind === 'platform' && isApiPlatformBinding(edge))
                continue;
            const code = inspectDependency(origin, target, node, neutralDependencyRoles);
            if (code) {
                report(
                    code,
                    id,
                    edge.to,
                    chain.length === 2 ? edge : edges.find((entry) => entry.to === chain[1]),
                    chain
                );
                continue;
            }
            // The entry owns its downstream privileges. This is not an exemption for helpers.
            if (PRESENTATION_ROLES.has(origin.kind) && target.kind === 'api') continue;
            if (
                origin.kind === 'module' &&
                moduleCapabilityEntry(origin.path) &&
                target.kind === 'module' &&
                target.module === origin.module &&
                target.io &&
                chain.length === 2
            )
                continue;
            if (
                origin.kind === 'module' &&
                origin.io &&
                ['database', 'platform'].includes(target.kind)
            )
                continue;
            if (
                ['workflow', 'composition', 'adapter', 'api', 'bootstrap'].includes(origin.kind) &&
                target.kind === 'module' &&
                publicModulePath(target.path)
            )
                continue;
            if (node.external || visited.has(edge.to)) continue;
            visited.add(edge.to);
            for (const next of graph.adjacency.get(edge.to) ?? [])
                queue.push({ edge: next, chain: [...chain, next.to] });
        }
    }
    for (const item of graph.unresolvedLocal)
        report('unresolved-local', item.importer, item.specifier, item, [
            item.importer,
            item.specifier,
        ]);
    for (const item of graph.unresolvedDynamic) {
        if (constrained(sourceRole(item.importer)))
            report('unresolved-dynamic', item.importer, null, item, [item.importer]);
    }
    const roleCounts = {};
    for (const file of graph.files) {
        const id = path.relative(projectRoot, file).split(path.sep).join('/');
        const role = sourceRole(id).kind;
        roleCounts[role] = (roleCounts[role] ?? 0) + 1;
    }

    return {
        fileCount: graph.files.length,
        roleCounts,
        violations,
        parseErrors: graph.parseErrors,
        sourceErrors: graph.sourceErrors,
        runtimeCycles: runtimeCycles(graph),
    };
}

export function runCli(argv) {
    let projectRoot = PROJECT_ROOT;
    let json = false;
    const seen = new Set();
    for (let index = 0; index < argv.length; index++) {
        const arg = argv[index];
        if (seen.has(arg)) throw new Error(`${arg} may only be specified once`);
        seen.add(arg);
        if (arg === '--json') json = true;
        else if (arg === '--project-root') {
            const value = argv[++index];
            if (!value?.trim() || value.startsWith('--'))
                throw new Error('--project-root requires a path');
            projectRoot = path.resolve(value);
        } else throw new Error(`unknown option: ${arg}`);
    }
    const result = analyzeRepository({ projectRoot });
    if (json) process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
    else {
        process.stdout.write(
            `Architecture: ${result.fileCount} files, ${result.violations.length} violations, ${result.runtimeCycles.length} runtime cycles.\n`
        );
        for (const item of result.violations)
            process.stdout.write(
                `[${item.code}] ${item.from}:${item.line}${item.to ? ` -> ${item.to}` : ''}\n`
            );
        for (const cycle of result.runtimeCycles)
            process.stdout.write(`[runtime-cycle] ${cycle.join(' -> ')}\n`);
        for (const item of [...result.parseErrors, ...result.sourceErrors])
            process.stdout.write(`[incomplete-graph] ${JSON.stringify(item)}\n`);
    }
    return result.violations.length ||
        result.runtimeCycles.length ||
        result.parseErrors.length ||
        result.sourceErrors.length
        ? 1
        : 0;
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
    try {
        process.exitCode = runCli(process.argv.slice(2));
    } catch (error) {
        process.stderr.write(`${error.stack ?? error}\n`);
        process.exitCode = 1;
    }
}

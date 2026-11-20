import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

import { beforeAll, describe, expect, it } from 'vitest';

import { buildModuleGraph, collectImports } from '../../../tooling/architecture/module-graph.mjs';

const projectRoot = fileURLToPath(new URL('../../../', import.meta.url));
let graph: ReturnType<typeof buildModuleGraph>;

beforeAll(() => {
    graph = buildModuleGraph({ projectRoot, srcRoot: projectRoot });
    expect(graph.parseErrors).toEqual([]);
    expect(graph.sourceErrors).toEqual([]);
}, 60_000);

function eagerDependencies(entry: string) {
    const reachable = new Set<string>([entry]);
    const queue = [entry];
    for (const source of queue) {
        for (const edge of graph.adjacency.get(source) ?? []) {
            if (edge.kind === 'dynamic' || edge.kind === 'type' || reachable.has(edge.to)) continue;
            reachable.add(edge.to);
            queue.push(edge.to);
        }
    }
    return reachable;
}

function eagerlyLoadsSnapshot(reachable: Set<string>): boolean {
    // The architecture graph omits asset nodes, so inspect their import edges too.
    return [...reachable].some((id) => {
        const source = graph.nodes.get(id);
        if (!source?.absolute) return false;
        return collectImports(readFileSync(source.absolute, 'utf8'), source.absolute).some(
            (edge) =>
                edge.kind !== 'dynamic' &&
                edge.kind !== 'type' &&
                edge.specifier.endsWith('/snapshot.json')
        );
    });
}

describe('given Models metadata and its ordinary display entries', () => {
    it('user loads the metadata owner without eagerly parsing the bundled fallback snapshot', () => {
        const reachable = eagerDependencies('apps/desktop/src/modules/models/index.ts');
        expect(reachable.has('apps/desktop/src/modules/models/metadata/create.io.ts')).toBe(true);
        expect(eagerlyLoadsSnapshot(reachable)).toBe(false);
        expect([...reachable].some((id) => id.startsWith('package:@ai-sdk/'))).toBe(false);
    });

    it('user queries ordinary model metadata without eagerly loading a provider driver or the snapshot', () => {
        const reachable = eagerDependencies('apps/desktop/src/app/api/models/metadata.ts');
        expect(reachable.has('apps/desktop/src/modules/models/metadata/refresh.io.ts')).toBe(false);
        expect([...reachable].some((id) => id.startsWith('apps/desktop/src/database/'))).toBe(
            false
        );
        expect(eagerlyLoadsSnapshot(reachable)).toBe(false);
        expect([...reachable].some((id) => id.startsWith('package:@ai-sdk/'))).toBe(false);
    });
});

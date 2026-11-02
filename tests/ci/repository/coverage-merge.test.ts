import { createRequire } from 'node:module';

import { describe, expect, it } from 'vitest';

type Location = {
    line: number;
    column: number;
};

type Range = {
    start: Location;
    end: Location;
};

type FunctionMapping = {
    name: string;
    line: number;
    loc: Range;
    decl?: Range;
};

type BranchMapping = {
    line: number;
    loc: Range;
    type: string;
    locations: Range[];
};

type FileCoverageData = {
    path: string;
    statementMap: Record<string, Range>;
    fnMap: Record<string, FunctionMapping>;
    branchMap: Record<string, BranchMapping>;
    s: Record<string, number>;
    f: Record<string, number>;
    b: Record<string, number[]>;
    all?: boolean;
};

type SummaryTotals = {
    total: number;
    covered: number;
    skipped: number;
    pct: number | string;
};

type SummaryData = {
    lines: SummaryTotals;
    statements: SummaryTotals;
    functions: SummaryTotals;
    branches: SummaryTotals;
};

type FileCoverageLike = {
    toJSON(): FileCoverageData;
    toSummary(): { toJSON(): SummaryData };
};

type CoverageMapLike = {
    addFileCoverage(coverage: FileCoverageLike): void;
    fileCoverageFor(path: string): FileCoverageLike;
    getCoverageSummary(): { toJSON(): SummaryData };
    merge(other: CoverageMapLike): void;
    toJSON(): Record<string, FileCoverageLike>;
    files(): string[];
};

type CoverageFactory = {
    createCoverageMap(): CoverageMapLike;
    createFileCoverage(data: FileCoverageData): FileCoverageLike;
};

type FunctionEntry = {
    id: string;
    mapping: FunctionMapping;
    hits: number;
};

type BranchEntry = {
    id: string;
    mapping: BranchMapping;
    hits: number[];
};

type ShardFixture = {
    idBase: number;
    functions: FunctionEntry[];
    branches?: BranchEntry[];
    statementHits?: number;
};

type FunctionObservation = {
    mapping: FunctionMapping;
    hits: number;
};

type BranchObservation = {
    mapping: BranchMapping;
    hits: number[];
};

const desktopRequire = createRequire(
    new URL('../../../apps/desktop/package.json', import.meta.url)
);
const coverageProviderRequire = createRequire(desktopRequire.resolve('@vitest/coverage-v8'));
const coverage = coverageProviderRequire(
    coverageProviderRequire.resolve('istanbul-lib-coverage')
) as CoverageFactory;

const fixturePath = 'fixture.ts';
const statementMapping = range(1, 0, 1, 20);
const permutations = [
    [0, 1, 2],
    [0, 2, 1],
    [1, 0, 2],
    [1, 2, 0],
    [2, 0, 1],
    [2, 1, 0],
] as const;
const mergePlans = [
    ...permutations.map((order) => ({ grouping: 'left' as const, order })),
    ...permutations.map((order) => ({ grouping: 'right' as const, order })),
];

function location(line: number, column: number): Location {
    return { line, column };
}

function range(startLine: number, startColumn: number, endLine: number, endColumn: number): Range {
    return {
        start: location(startLine, startColumn),
        end: location(endLine, endColumn),
    };
}

function functionMapping(name: string, loc: Range, decl?: Range): FunctionMapping {
    return decl ? { name, line: loc.start.line, loc, decl } : { name, line: loc.start.line, loc };
}

function branchMapping(type: string, loc: Range, locations: Range[]): BranchMapping {
    return { line: loc.start.line, loc, type, locations };
}

function shardData(fixture: ShardFixture): FileCoverageData {
    const fnMap: Record<string, FunctionMapping> = {};
    const f: Record<string, number> = {};
    fixture.functions.forEach((entry, index) => {
        const id = String(fixture.idBase + index);
        fnMap[id] = structuredClone(entry.mapping);
        f[id] = entry.hits;
    });

    const branchMap: Record<string, BranchMapping> = {};
    const b: Record<string, number[]> = {};
    (fixture.branches ?? []).forEach((entry, index) => {
        const id = String(fixture.idBase + 100 + index);
        branchMap[id] = structuredClone(entry.mapping);
        b[id] = [...entry.hits];
    });

    return {
        path: fixturePath,
        statementMap: { 0: structuredClone(statementMapping) },
        fnMap,
        branchMap,
        s: { 0: fixture.statementHits ?? 1 },
        f,
        b,
    };
}

function shardMap(fixture: ShardFixture): CoverageMapLike {
    const map = coverage.createCoverageMap();
    map.addFileCoverage(coverage.createFileCoverage(shardData(fixture)));
    return map;
}

function mergeGrouped(
    fixtures: ShardFixture[],
    order: readonly number[],
    grouping: 'left' | 'right'
): CoverageMapLike {
    if (grouping === 'left') {
        const merged = coverage.createCoverageMap();
        for (const index of order) {
            merged.merge(shardMap(fixtures[index]!));
        }
        return merged;
    }

    let merged = coverage.createCoverageMap();
    for (let position = order.length - 1; position >= 0; position -= 1) {
        const next = shardMap(fixtures[order[position]!]!);
        next.merge(merged);
        merged = next;
    }
    return merged;
}

function mergedResults(fixtures: ShardFixture[]) {
    return mergePlans.map(({ grouping, order }) => {
        const map = mergeGrouped(fixtures, order, grouping);
        const raw = JSON.parse(JSON.stringify(map.toJSON())) as Record<string, FileCoverageData>;
        const data = raw[fixturePath];
        if (!data) throw new Error('Merged coverage did not retain the fixture file');

        return {
            plan: `${grouping} ${order.join(',')}`,
            data,
            summary: map.fileCoverageFor(fixturePath).toSummary().toJSON(),
        };
    });
}

function sortedFunctions(observations: FunctionObservation[]): FunctionObservation[] {
    return [...observations].sort((left, right) =>
        JSON.stringify(left).localeCompare(JSON.stringify(right))
    );
}

function sortedBranches(observations: BranchObservation[]): BranchObservation[] {
    return [...observations].sort((left, right) =>
        JSON.stringify(left).localeCompare(JSON.stringify(right))
    );
}

function expectCompleteMappingInventory(data: FileCoverageData): void {
    expect(Object.keys(data.s).sort()).toEqual(Object.keys(data.statementMap).sort());
    expect(Object.keys(data.f).sort()).toEqual(Object.keys(data.fnMap).sort());
    expect(Object.keys(data.b).sort()).toEqual(Object.keys(data.branchMap).sort());
    expect(
        Object.entries(data.statementMap)
            .sort(([left], [right]) => left.localeCompare(right))
            .map(([, mapping]) => mapping)
    ).toEqual([statementMapping]);
}

function functionInventory(data: FileCoverageData): FunctionObservation[] {
    expectCompleteMappingInventory(data);
    return sortedFunctions(
        Object.entries(data.f).map(([id, hits]) => ({
            mapping: data.fnMap[id]!,
            hits,
        }))
    );
}

function branchInventory(data: FileCoverageData): BranchObservation[] {
    expectCompleteMappingInventory(data);
    return sortedBranches(
        Object.entries(data.b).map(([id, hits]) => ({
            mapping: data.branchMap[id]!,
            hits: [...hits],
        }))
    );
}

function expectFiniteCountersAndArmLengths(data: FileCoverageData): void {
    expectCompleteMappingInventory(data);
    for (const hits of Object.values(data.s)) {
        expect(Number.isFinite(hits)).toBe(true);
    }
    for (const hits of Object.values(data.f)) {
        expect(Number.isFinite(hits)).toBe(true);
    }
    for (const [id, hits] of Object.entries(data.b)) {
        expect(hits).toHaveLength(data.branchMap[id]!.locations.length);
        for (const armHits of hits) {
            expect(Number.isFinite(armHits)).toBe(true);
        }
    }
}

describe('user merges coverage from complete frontend shard maps', () => {
    it('user keeps covered and uncovered generated functions with nonzero and point-sized bodies in every merge order', () => {
        const body = range(40, 10, 40, 50);
        const declaration = range(40, 0, 40, 9);
        const zeroWidthDeclaration = range(40, 10, 40, 10);
        const zeroWidthBody = range(41, 10, 41, 10);
        const firstZeroWidthDeclaration = range(41, 0, 41, 9);
        const secondZeroWidthDeclaration = range(41, 10, 41, 10);
        const fixtures: ShardFixture[] = [
            {
                idBase: 30,
                functions: [
                    {
                        id: 'covered',
                        mapping: functionMapping('generated', body, declaration),
                        hits: 2,
                    },
                    {
                        id: 'uncovered',
                        mapping: functionMapping('generated', body, zeroWidthDeclaration),
                        hits: 0,
                    },
                    {
                        id: 'zero-width-covered',
                        mapping: functionMapping(
                            'generated',
                            zeroWidthBody,
                            firstZeroWidthDeclaration
                        ),
                        hits: 1,
                    },
                    {
                        id: 'zero-width-uncovered',
                        mapping: functionMapping(
                            'generated',
                            zeroWidthBody,
                            secondZeroWidthDeclaration
                        ),
                        hits: 0,
                    },
                ],
            },
            {
                idBase: 700,
                functions: [
                    {
                        id: 'covered',
                        mapping: functionMapping('generated', body, declaration),
                        hits: 0,
                    },
                    {
                        id: 'uncovered',
                        mapping: functionMapping('generated', body, zeroWidthDeclaration),
                        hits: 0,
                    },
                    {
                        id: 'zero-width-covered',
                        mapping: functionMapping(
                            'generated',
                            zeroWidthBody,
                            firstZeroWidthDeclaration
                        ),
                        hits: 0,
                    },
                    {
                        id: 'zero-width-uncovered',
                        mapping: functionMapping(
                            'generated',
                            zeroWidthBody,
                            secondZeroWidthDeclaration
                        ),
                        hits: 0,
                    },
                ],
            },
            {
                idBase: 4,
                functions: [
                    {
                        id: 'covered',
                        mapping: functionMapping('generated', body, declaration),
                        hits: 3,
                    },
                    {
                        id: 'uncovered',
                        mapping: functionMapping('generated', body, zeroWidthDeclaration),
                        hits: 0,
                    },
                    {
                        id: 'zero-width-covered',
                        mapping: functionMapping(
                            'generated',
                            zeroWidthBody,
                            firstZeroWidthDeclaration
                        ),
                        hits: 4,
                    },
                    {
                        id: 'zero-width-uncovered',
                        mapping: functionMapping(
                            'generated',
                            zeroWidthBody,
                            secondZeroWidthDeclaration
                        ),
                        hits: 0,
                    },
                ],
            },
        ];
        const expected = sortedFunctions([
            {
                mapping: functionMapping('generated', body, declaration),
                hits: 5,
            },
            {
                mapping: functionMapping('generated', body, zeroWidthDeclaration),
                hits: 0,
            },
            {
                mapping: functionMapping('generated', zeroWidthBody, firstZeroWidthDeclaration),
                hits: 5,
            },
            {
                mapping: functionMapping('generated', zeroWidthBody, secondZeroWidthDeclaration),
                hits: 0,
            },
        ]);

        for (const { plan, data, summary } of mergedResults(fixtures)) {
            expect(functionInventory(data), plan).toEqual(expected);
            expect(data.s, plan).toEqual({ 0: 3 });
            expect(summary.functions, plan).toMatchObject({ total: 4, covered: 2, skipped: 0 });
            expect(Number.isFinite(summary.functions.pct), plan).toBe(true);
            expect(summary.statements, plan).toMatchObject({ total: 1, covered: 1, skipped: 0 });
            expect(summary.lines, plan).toMatchObject({ total: 1, covered: 1, skipped: 0 });
            expectFiniteCountersAndArmLengths(data);
        }
    });

    it('user keeps branches sharing a first arm but differing in complete ordered arms in every merge order', () => {
        const firstArm = range(50, 0, 50, 10);
        const secondArm = range(50, 10, 50, 20);
        const alternateSecondArm = range(50, 20, 50, 30);
        const outer = range(50, 0, 50, 30);
        const firstBranch = branchMapping('cond-expr', outer, [firstArm, secondArm]);
        const secondBranch = branchMapping('cond-expr', outer, [firstArm, alternateSecondArm]);
        const fixtures: ShardFixture[] = [
            {
                idBase: 12,
                functions: [],
                branches: [
                    { id: 'first', mapping: firstBranch, hits: [2, 0] },
                    { id: 'second', mapping: secondBranch, hits: [0, 2] },
                ],
            },
            {
                idBase: 900,
                functions: [],
                branches: [
                    { id: 'first', mapping: firstBranch, hits: [0, 3] },
                    { id: 'second', mapping: secondBranch, hits: [4, 0] },
                ],
            },
            {
                idBase: 2,
                functions: [],
                branches: [
                    { id: 'first', mapping: firstBranch, hits: [1, 1] },
                    { id: 'second', mapping: secondBranch, hits: [1, 0] },
                ],
            },
        ];
        const expected = sortedBranches([
            { mapping: firstBranch, hits: [3, 4] },
            { mapping: secondBranch, hits: [5, 2] },
        ]);

        for (const { plan, data, summary } of mergedResults(fixtures)) {
            expect(branchInventory(data), plan).toEqual(expected);
            expect(summary.branches, plan).toMatchObject({ total: 4, covered: 4, skipped: 0 });
            expectFiniteCountersAndArmLengths(data);
        }
    });

    it('user keeps branches with different types, arm counts and arm order in every merge order', () => {
        const firstArm = range(60, 0, 60, 10);
        const secondArm = range(60, 10, 60, 20);
        const thirdArm = range(60, 20, 60, 30);
        const outer = range(60, 0, 60, 30);
        const conditional = branchMapping('cond-expr', outer, [firstArm, secondArm]);
        const binary = branchMapping('binary-expr', outer, [firstArm, secondArm]);
        const longer = branchMapping('cond-expr', outer, [firstArm, secondArm, thirdArm]);
        const reordered = branchMapping('cond-expr', outer, [firstArm, thirdArm, secondArm]);
        const fixtures: ShardFixture[] = [
            {
                idBase: 21,
                functions: [],
                branches: [
                    { id: 'conditional', mapping: conditional, hits: [2, 1] },
                    { id: 'binary', mapping: binary, hits: [1, 0] },
                    { id: 'longer', mapping: longer, hits: [0, 1, 0] },
                    { id: 'reordered', mapping: reordered, hits: [1, 0, 0] },
                ],
            },
            {
                idBase: 400,
                functions: [],
                branches: [
                    { id: 'conditional', mapping: conditional, hits: [1, 0] },
                    { id: 'binary', mapping: binary, hits: [0, 2] },
                    { id: 'longer', mapping: longer, hits: [2, 0, 0] },
                    { id: 'reordered', mapping: reordered, hits: [0, 2, 0] },
                ],
            },
            {
                idBase: 8,
                functions: [],
                branches: [
                    { id: 'conditional', mapping: conditional, hits: [0, 3] },
                    { id: 'binary', mapping: binary, hits: [2, 0] },
                    { id: 'longer', mapping: longer, hits: [1, 0, 0] },
                    { id: 'reordered', mapping: reordered, hits: [1, 1, 1] },
                ],
            },
        ];
        const expected = sortedBranches([
            { mapping: conditional, hits: [3, 4] },
            { mapping: binary, hits: [3, 2] },
            { mapping: longer, hits: [3, 1, 0] },
            { mapping: reordered, hits: [2, 3, 1] },
        ]);

        for (const { plan, data, summary } of mergedResults(fixtures)) {
            expect(branchInventory(data), plan).toEqual(expected);
            expect(summary.branches, plan).toMatchObject({ total: 10, covered: 9, skipped: 0 });
            expectFiniteCountersAndArmLengths(data);
        }
    });

    it('user keeps uncovered functions and branch arms beside covered colliding mappings', () => {
        const body = range(70, 0, 70, 30);
        const firstDeclaration = range(70, 0, 70, 5);
        const zeroWidthDeclaration = range(70, 5, 70, 5);
        const firstArm = range(71, 0, 71, 10);
        const coveredSecondArm = range(71, 10, 71, 20);
        const uncoveredSecondArm = range(71, 20, 71, 30);
        const branchOuter = range(71, 0, 71, 30);
        const coveredBranch = branchMapping('cond-expr', branchOuter, [firstArm, coveredSecondArm]);
        const uncoveredBranch = branchMapping('cond-expr', branchOuter, [
            firstArm,
            uncoveredSecondArm,
        ]);
        const fixtures: ShardFixture[] = [
            {
                idBase: 17,
                functions: [
                    {
                        id: 'covered',
                        mapping: functionMapping('covered', body, firstDeclaration),
                        hits: 2,
                    },
                    {
                        id: 'uncovered',
                        mapping: functionMapping('uncovered', body, zeroWidthDeclaration),
                        hits: 0,
                    },
                ],
                branches: [
                    { id: 'covered', mapping: coveredBranch, hits: [2, 0] },
                    { id: 'uncovered', mapping: uncoveredBranch, hits: [0, 0] },
                ],
            },
            {
                idBase: 300,
                functions: [
                    {
                        id: 'covered',
                        mapping: functionMapping('covered', body, firstDeclaration),
                        hits: 3,
                    },
                    {
                        id: 'uncovered',
                        mapping: functionMapping('uncovered', body, zeroWidthDeclaration),
                        hits: 0,
                    },
                ],
                branches: [
                    { id: 'covered', mapping: coveredBranch, hits: [0, 4] },
                    { id: 'uncovered', mapping: uncoveredBranch, hits: [0, 0] },
                ],
            },
            {
                idBase: 5,
                functions: [
                    {
                        id: 'covered',
                        mapping: functionMapping('covered', body, firstDeclaration),
                        hits: 1,
                    },
                    {
                        id: 'uncovered',
                        mapping: functionMapping('uncovered', body, zeroWidthDeclaration),
                        hits: 0,
                    },
                ],
                branches: [
                    { id: 'covered', mapping: coveredBranch, hits: [1, 1] },
                    { id: 'uncovered', mapping: uncoveredBranch, hits: [0, 0] },
                ],
            },
        ];
        const expectedFunctions = sortedFunctions([
            {
                mapping: functionMapping('covered', body, firstDeclaration),
                hits: 6,
            },
            {
                mapping: functionMapping('uncovered', body, zeroWidthDeclaration),
                hits: 0,
            },
        ]);
        const expectedBranches = sortedBranches([
            { mapping: coveredBranch, hits: [3, 5] },
            { mapping: uncoveredBranch, hits: [0, 0] },
        ]);

        for (const { plan, data, summary } of mergedResults(fixtures)) {
            expect(functionInventory(data), plan).toEqual(expectedFunctions);
            expect(branchInventory(data), plan).toEqual(expectedBranches);
            expect(summary.functions, plan).toMatchObject({ total: 2, covered: 1, skipped: 0 });
            expect(summary.branches, plan).toMatchObject({ total: 4, covered: 2, skipped: 0 });
            expectFiniteCountersAndArmLengths(data);
        }
    });
});

describe('user merges ordinary and compatible coverage maps', () => {
    it('user sees no change when merging empty maps', () => {
        const map = coverage.createCoverageMap();
        map.merge(coverage.createCoverageMap());

        expect(map.files()).toEqual([]);
        expect(map.getCoverageSummary().toJSON().functions).toMatchObject({
            total: 0,
            covered: 0,
            skipped: 0,
        });
    });

    it('user sees synthetic all-file coverage replaced by measured coverage and unable to replace it back', () => {
        const body = range(80, 0, 80, 20);
        const declaration = range(80, 0, 80, 5);
        const measured = shardMap({
            idBase: 44,
            functions: [
                {
                    id: 'measured',
                    mapping: functionMapping('measured', body, declaration),
                    hits: 7,
                },
            ],
        });
        const syntheticMap = () => {
            const data = shardData({
                idBase: 90,
                functions: [
                    {
                        id: 'synthetic',
                        mapping: functionMapping('synthetic', body, declaration),
                        hits: 0,
                    },
                ],
            });
            data.all = true;
            const map = coverage.createCoverageMap();
            map.addFileCoverage(coverage.createFileCoverage(data));
            return map;
        };

        const synthetic = syntheticMap();
        synthetic.merge(measured);
        const syntheticResult = JSON.parse(JSON.stringify(synthetic.toJSON())) as Record<
            string,
            FileCoverageData
        >;
        expect(functionInventory(syntheticResult[fixturePath]!)).toEqual([
            { mapping: functionMapping('measured', body, declaration), hits: 7 },
        ]);

        measured.merge(syntheticMap());
        const measuredResult = JSON.parse(JSON.stringify(measured.toJSON())) as Record<
            string,
            FileCoverageData
        >;
        expect(functionInventory(measuredResult[fixturePath]!)).toEqual([
            { mapping: functionMapping('measured', body, declaration), hits: 7 },
        ]);
    });

    it('user keeps consistently absent function declarations additive', () => {
        const body = range(81, 0, 81, 20);
        const fixtures: ShardFixture[] = [
            {
                idBase: 1,
                functions: [
                    {
                        id: 'same',
                        mapping: functionMapping('same', body),
                        hits: 2,
                    },
                ],
            },
            {
                idBase: 20,
                functions: [
                    {
                        id: 'same',
                        mapping: functionMapping('same', body),
                        hits: 3,
                    },
                ],
            },
            {
                idBase: 300,
                functions: [
                    {
                        id: 'same',
                        mapping: functionMapping('same', body),
                        hits: 5,
                    },
                ],
            },
        ];

        for (const { plan, data } of mergedResults(fixtures)) {
            expect(functionInventory(data), plan).toEqual([
                { mapping: functionMapping('same', body), hits: 10 },
            ]);
        }
    });

    it('user keeps identical declared functions additive', () => {
        const body = range(82, 0, 82, 20);
        const declaration = range(82, 0, 82, 6);
        const fixtures: ShardFixture[] = [
            {
                idBase: 2,
                functions: [
                    {
                        id: 'same',
                        mapping: functionMapping('same', body, declaration),
                        hits: 1,
                    },
                ],
            },
            {
                idBase: 40,
                functions: [
                    {
                        id: 'same',
                        mapping: functionMapping('same', body, declaration),
                        hits: 4,
                    },
                ],
            },
            {
                idBase: 600,
                functions: [
                    {
                        id: 'same',
                        mapping: functionMapping('same', body, declaration),
                        hits: 6,
                    },
                ],
            },
        ];

        for (const { plan, data } of mergedResults(fixtures)) {
            expect(functionInventory(data), plan).toEqual([
                { mapping: functionMapping('same', body, declaration), hits: 11 },
            ]);
        }
    });

    it('user keeps nearest containing range hits when mappings differ', () => {
        const outer = range(83, 0, 83, 30);
        const inner = range(83, 5, 83, 10);
        const outerMap = shardMap({
            idBase: 3,
            functions: [
                {
                    id: 'outer',
                    mapping: functionMapping('outer', outer),
                    hits: 4,
                },
            ],
        });
        const innerMap = shardMap({
            idBase: 8,
            functions: [
                {
                    id: 'inner',
                    mapping: functionMapping('inner', inner),
                    hits: 0,
                },
            ],
        });

        outerMap.merge(innerMap);
        const result = JSON.parse(JSON.stringify(outerMap.toJSON())) as Record<
            string,
            FileCoverageData
        >;

        expect(functionInventory(result[fixturePath]!)).toEqual(
            sortedFunctions([
                { mapping: functionMapping('outer', outer), hits: 4 },
                { mapping: functionMapping('inner', inner), hits: 4 },
            ])
        );
    });
});

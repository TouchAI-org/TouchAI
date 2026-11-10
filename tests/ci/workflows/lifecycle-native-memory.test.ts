import { spawnSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import { assert, beforeAll, describe, expect, it } from 'vitest';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '../../..');
const appPath = join(tmpdir(), 'touchai native memory fixture', 'TouchAI.exe');
const memoryScript = join(root, 'apps/desktop/e2e-tests/performance/process-memory.ps1');
const shell = process.platform === 'win32' ? 'powershell.exe' : 'pwsh';
const systemBoundary = `
$ErrorActionPreference = 'Stop'
[Console]::Error.WriteLine('Native memory fixtures: process started')
$fixtures = [Console]::In.ReadToEnd() | ConvertFrom-Json
[Console]::Error.WriteLine("Native memory fixtures: parsed $($fixtures.Count) inputs")
function Get-CimInstance {
    param([string]$ClassName)
    if ($ClassName -ne 'Win32_Process') { throw 'Unexpected system query.' }
    if ($fixture.queryError) { throw $fixture.queryError }
    foreach ($nativeProcess in $fixture.processes) {
        if ($null -ne $nativeProcess.CreationDate) {
            $nativeProcess.CreationDate = ([DateTimeOffset]$nativeProcess.CreationDate).LocalDateTime
        }
        $nativeProcess
    }
}
function Get-Process {
    param([int[]]$Id)
    foreach ($processId in $Id) {
        $live = @($fixture.liveProcesses | Where-Object { $_.Id -eq $processId })
        if ($live.Count -ne 1) { throw "Cannot find a process with identifier $processId." }
        $live[0]
    }
}
$fixtureIndex = 0
$reports = foreach ($fixture in $fixtures) {
    $fixtureIndex += 1
    [Console]::Error.WriteLine("Native memory fixtures: collecting $fixtureIndex/$($fixtures.Count)")
    $output = @()
    try {
        $output = @(& $env:TOUCHAI_MEMORY_SCRIPT)
        @{ output = $output -join [Environment]::NewLine; error = $null }
    } catch {
        @{ output = $output -join [Environment]::NewLine; error = $_.Exception.Message }
    }
}
[Console]::Error.WriteLine('Native memory fixtures: serializing reports')
ConvertTo-Json -InputObject @($reports) -Depth 3 -Compress
[Console]::Error.WriteLine('Native memory fixtures: reports serialized')
`;

interface NativeProcess {
    ProcessId: number;
    ParentProcessId: number;
    Name: string;
    CreationDate: string | null;
    ExecutablePath: string | null;
    CommandLine: string;
    PrivatePageCount: number | null;
    WorkingSetSize: number | null;
}

function fixture() {
    const processes: NativeProcess[] = [
        {
            ProcessId: 30,
            ParentProcessId: 20,
            Name: 'msedgewebview2.exe',
            CreationDate: '2026-11-10T00:00:02Z',
            ExecutablePath: null,
            CommandLine: 'msedgewebview2.exe --type=renderer',
            PrivatePageCount: 3000,
            WorkingSetSize: 5000,
        },
        {
            ProcessId: 40,
            ParentProcessId: 1,
            Name: 'unrelated.exe',
            CreationDate: '2026-11-09T23:59:59Z',
            ExecutablePath: `${appPath}.other`,
            CommandLine: 'unrelated.exe --type=renderer',
            PrivatePageCount: 900000,
            WorkingSetSize: 900000,
        },
        {
            ProcessId: 10,
            ParentProcessId: 1,
            Name: 'TouchAI.exe',
            CreationDate: '2026-11-10T00:00:00Z',
            ExecutablePath: appPath,
            CommandLine: 'TouchAI.exe',
            PrivatePageCount: 5000000000,
            WorkingSetSize: 6000000000,
        },
        {
            ProcessId: 20,
            ParentProcessId: 10,
            Name: 'msedgewebview2.exe',
            CreationDate: '2026-11-10T00:00:01Z',
            ExecutablePath: join(dirname(appPath), 'msedgewebview2.exe'),
            CommandLine: 'msedgewebview2.exe',
            PrivatePageCount: 2000,
            WorkingSetSize: 4000,
        },
    ];
    return {
        processes,
        liveProcesses: processes.map((nativeProcess) => ({
            Id: nativeProcess.ProcessId,
            PrivateMemorySize64: nativeProcess.PrivatePageCount,
            WorkingSet64: nativeProcess.WorkingSetSize,
        })),
        queryError: '',
    };
}

function sample(inputs: ReturnType<typeof fixture>[]) {
    const result = spawnSync(
        shell,
        [
            '-NoProfile',
            '-NonInteractive',
            '-EncodedCommand',
            Buffer.from(systemBoundary, 'utf16le').toString('base64'),
        ],
        {
            env: {
                ...process.env,
                TOUCHAI_PERF_APP: appPath,
                TOUCHAI_MEMORY_SCRIPT: memoryScript,
            },
            input: JSON.stringify(inputs),
            encoding: 'utf8',
            windowsHide: true,
            timeout: 15000,
        }
    );
    if (result.error) {
        throw Object.assign(
            new Error(
                `Native memory fixtures did not finish: ${result.error.message}\n${result.stderr || 'No subprocess progress was captured.'}`
            ),
            { cause: result.error }
        );
    }
    expect(result.status, result.stderr).toBe(0);
    return JSON.parse(result.stdout) as { output: string; error: string | null }[];
}

const expectedMemory = {
    privateBytes: 5000005000,
    workingSetBytes: 6000009000,
    processes: 3,
    renderers: 1,
};

interface Scenario {
    name: string;
    change?: (input: ReturnType<typeof fixture>) => void;
    error?: string;
    expected?: typeof expectedMemory;
    verify?: (report: unknown) => void;
}

function attachUnrelatedBranch(
    input: ReturnType<typeof fixture>,
    parentId: number,
    creationDate: string
) {
    const unrelated = input.processes.find((nativeProcess) => nativeProcess.ProcessId === 40);
    assert(unrelated);
    unrelated.ParentProcessId = parentId;
    unrelated.CreationDate = creationDate;
    input.processes.push({
        ...unrelated,
        ProcessId: 50,
        ParentProcessId: 40,
        CreationDate: '2026-11-10T00:00:03Z',
    });
}

const scenarios: Scenario[] = [
    {
        name: 'user captures a complete process tree and receives full-width memory totals without unrelated renderers',
    },
    {
        name: 'user samples a child that exits after enumeration and still receives the captured tree memory',
        change(input) {
            input.liveProcesses = input.liveProcesses.filter(
                (nativeProcess) => nativeProcess.Id !== 30
            );
        },
    },
    {
        name: 'user samples a child whose identifier is reused and never counts the replacement process memory',
        change(input) {
            assert(input.liveProcesses[0]);
            input.liveProcesses[0].PrivateMemorySize64 = 9000000000;
            input.liveProcesses[0].WorkingSet64 = 9000000000;
        },
    },
    {
        name: 'user samples a reused app identifier and excludes older unrelated processes and their descendants',
        change(input) {
            attachUnrelatedBranch(input, 10, '2026-11-09T23:59:59Z');
        },
        verify(report) {
            expect(report).toHaveProperty('rejectedParentReuses', [
                {
                    id: 40,
                    parentId: 10,
                    name: 'unrelated.exe',
                    createdAt: '2026-11-09T23:59:59.0000000Z',
                    parentCreatedAt: '2026-11-10T00:00:00.0000000Z',
                },
            ]);
        },
    },
    {
        name: 'user samples a reused child identifier and excludes older unrelated processes and their descendants',
        change(input) {
            attachUnrelatedBranch(input, 20, '2026-11-10T00:00:00Z');
        },
        verify(report) {
            expect(report).toHaveProperty('rejectedParentReuses', [
                {
                    id: 40,
                    parentId: 20,
                    name: 'unrelated.exe',
                    createdAt: '2026-11-10T00:00:00.0000000Z',
                    parentCreatedAt: '2026-11-10T00:00:01.0000000Z',
                },
            ]);
        },
    },
    {
        name: 'user samples a genuinely newer descendant and includes its memory regardless of executable or role',
        change(input) {
            assert(input.processes[1]);
            input.processes[1].ParentProcessId = 30;
            input.processes[1].CreationDate = '2026-11-10T00:00:03Z';
            input.processes[1].CommandLine = 'unrelated.exe --private-argument=not-a-renderer';
        },
        expected: {
            privateBytes: 5000905000,
            workingSetBytes: 6000909000,
            processes: 4,
            renderers: 1,
        },
    },
    {
        name: 'user samples a child created at the same recorded instant as its parent and retains its memory',
        change(input) {
            assert(input.processes[0]);
            input.processes[0].CreationDate = '2026-11-10T00:00:01Z';
        },
    },
    {
        name: 'user samples without the app creation time and receives an error instead of guessed ownership',
        change(input) {
            assert(input.processes[2]);
            input.processes[2].CreationDate = null;
        },
        error: 'did not include a creation time',
    },
    {
        name: 'user samples without a potential descendant creation time and receives an error instead of guessed ownership',
        change(input) {
            assert(input.processes[0]);
            input.processes[0].CreationDate = null;
        },
        error: 'did not include a creation time',
    },
    {
        name: 'user samples an unrelated process without a creation time and still receives the complete app memory',
        change(input) {
            assert(input.processes[1]);
            input.processes[1].CreationDate = null;
        },
    },
    {
        name: 'user inspects native memory evidence and sees process identities and counters without paths or command lines',
        change(input) {
            for (const nativeProcess of input.processes) {
                nativeProcess.CommandLine += ' --token=never-log-this';
            }
        },
        verify(report) {
            expect(report).toEqual({
                ...expectedMemory,
                processDetails: [
                    {
                        id: 10,
                        parentId: 1,
                        name: 'TouchAI.exe',
                        createdAt: '2026-11-10T00:00:00.0000000Z',
                        role: 'app',
                        privateBytes: 5000000000,
                        workingSetBytes: 6000000000,
                    },
                    {
                        id: 20,
                        parentId: 10,
                        name: 'msedgewebview2.exe',
                        createdAt: '2026-11-10T00:00:01.0000000Z',
                        role: 'other',
                        privateBytes: 2000,
                        workingSetBytes: 4000,
                    },
                    {
                        id: 30,
                        parentId: 20,
                        name: 'msedgewebview2.exe',
                        createdAt: '2026-11-10T00:00:02.0000000Z',
                        role: 'renderer',
                        privateBytes: 3000,
                        workingSetBytes: 5000,
                    },
                ],
                rejectedParentReuses: [],
            });
        },
    },
    {
        name: 'user samples local creation times with different offsets and receives comparable UTC process identities',
        change(input) {
            assert(input.processes[2]);
            assert(input.processes[3]);
            input.processes[2].CreationDate = '2026-11-10T08:00:00+08:00';
            input.processes[3].CreationDate = '2026-11-09T16:00:01-08:00';
        },
        verify(report) {
            expect(report).toHaveProperty(
                'processDetails',
                expect.arrayContaining([
                    expect.objectContaining({
                        id: 10,
                        createdAt: '2026-11-10T00:00:00.0000000Z',
                    }),
                    expect.objectContaining({
                        id: 20,
                        createdAt: '2026-11-10T00:00:01.0000000Z',
                    }),
                ])
            );
        },
    },
    {
        name: 'user samples without the benchmark app and receives an error before a later valid sample succeeds',
        change(input) {
            input.processes = input.processes.filter(
                (nativeProcess) => nativeProcess.ProcessId !== 10
            );
        },
        error: 'Expected one benchmark app',
    },
    {
        name: 'user samples two matching app instances and cannot receive an ambiguous memory report',
        change(input) {
            assert(input.processes[2]);
            input.processes.push({ ...input.processes[2], ProcessId: 50 });
        },
        error: 'found 2',
    },
    {
        name: 'user samples without an owned renderer and cannot substitute an unrelated renderer',
        change(input) {
            input.processes = input.processes.filter(
                (nativeProcess) => nativeProcess.ProcessId !== 30
            );
        },
        error: 'did not include a WebView2 renderer',
    },
    {
        name: 'user samples unavailable private memory and receives an error instead of a zero fallback',
        change(input) {
            assert(input.processes[0]);
            input.processes[0].PrivatePageCount = null;
        },
        error: 'did not include native memory counters',
    },
    {
        name: 'user samples an unavailable working set and receives an error instead of a zero fallback',
        change(input) {
            assert(input.processes[0]);
            input.processes[0].WorkingSetSize = null;
        },
        error: 'did not include native memory counters',
    },
    {
        name: 'user encounters a failed system query and receives the failure while a later valid sample remains possible',
        change(input) {
            input.queryError = 'Native process information is unavailable.';
        },
        error: 'Native process information is unavailable.',
    },
];

let observations: ReturnType<typeof sample>;

beforeAll(() => {
    const inputs = scenarios.flatMap((scenario) => {
        const input = fixture();
        scenario.change?.(input);
        return [input, fixture()];
    });
    observations = sample(inputs);
    expect(observations).toHaveLength(inputs.length);
});

describe('user measures an isolated native application and its descendants', () => {
    scenarios.forEach((scenario, index) => {
        it(scenario.name, () => {
            const observation = observations[index * 2];
            assert(observation);
            if (scenario.error) {
                expect(observation.error).toContain(scenario.error);
                expect(observation.output).toBe('');
            } else {
                expect(observation.error).toBeNull();
                const report: unknown = JSON.parse(observation.output);
                expect(report).toMatchObject(scenario.expected ?? expectedMemory);
                scenario.verify?.(report);
            }
            const recovered = observations[index * 2 + 1];
            assert(recovered);
            expect(recovered.error).toBeNull();
            expect(JSON.parse(recovered.output)).toMatchObject(expectedMemory);
        });
    });
});

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
$fixtures = [Console]::In.ReadToEnd() | ConvertFrom-Json
function Get-CimInstance {
    param([string]$ClassName)
    if ($ClassName -ne 'Win32_Process') { throw 'Unexpected system query.' }
    if ($fixture.queryError) { throw $fixture.queryError }
    $fixture.processes
}
function Get-Process {
    param([int[]]$Id)
    foreach ($processId in $Id) {
        $live = @($fixture.liveProcesses | Where-Object { $_.Id -eq $processId })
        if ($live.Count -ne 1) { throw "Cannot find a process with identifier $processId." }
        $live[0]
    }
}
$reports = foreach ($fixture in $fixtures) {
    $output = @()
    try {
        $output = @(& $env:TOUCHAI_MEMORY_SCRIPT)
        @{ output = $output -join [Environment]::NewLine; error = $null }
    } catch {
        @{ output = $output -join [Environment]::NewLine; error = $_.Exception.Message }
    }
}
ConvertTo-Json -InputObject @($reports) -Depth 3 -Compress
`;

interface NativeProcess {
    ProcessId: number;
    ParentProcessId: number;
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
            ExecutablePath: null,
            CommandLine: 'msedgewebview2.exe --type=renderer',
            PrivatePageCount: 3000,
            WorkingSetSize: 5000,
        },
        {
            ProcessId: 40,
            ParentProcessId: 1,
            ExecutablePath: `${appPath}.other`,
            CommandLine: 'unrelated.exe --type=renderer',
            PrivatePageCount: 900000,
            WorkingSetSize: 900000,
        },
        {
            ProcessId: 10,
            ParentProcessId: 1,
            ExecutablePath: appPath,
            CommandLine: 'TouchAI.exe',
            PrivatePageCount: 5000000000,
            WorkingSetSize: 6000000000,
        },
        {
            ProcessId: 20,
            ParentProcessId: 10,
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
    if (result.error) throw result.error;
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
                expect(JSON.parse(observation.output)).toEqual(expectedMemory);
            }
            const recovered = observations[index * 2 + 1];
            assert(recovered);
            expect(recovered.error).toBeNull();
            expect(JSON.parse(recovered.output)).toEqual(expectedMemory);
        });
    });
});

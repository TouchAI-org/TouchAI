import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import { data, Evaluator, Lexer, Parser } from '@actions/expressions';
import { parseDocument } from 'yaml';

export interface WorkflowStep {
    id?: string;
    name?: string;
    uses?: string;
    run?: string;
    if?: string;
    env?: Record<string, string>;
    with?: Record<string, unknown>;
    [key: string]: unknown;
}

export interface WorkflowJob {
    name?: string;
    if?: string;
    needs?: string | string[];
    steps: WorkflowStep[];
    [key: string]: unknown;
}

export interface Workflow {
    name: string;
    on: Record<string, unknown>;
    concurrency: {
        group: string;
        'cancel-in-progress': string | boolean;
    };
    jobs: Record<string, WorkflowJob>;
}

interface ClassifierOptions {
    eventName: string;
    payload?: Record<string, unknown>;
    pullRequestNumber?: number;
    listFilePages?: unknown[][];
    listFilesError?: Error;
    compareData?: Record<string, unknown>;
    compareError?: Error;
}

export interface ClassifierResult {
    outputs: Record<string, string>;
    paginateCalls: Array<{
        method: unknown;
        params: Record<string, unknown>;
    }>;
    compareCalls: Array<Record<string, unknown>>;
}

const repositoryRoot = fileURLToPath(new URL('../../../', import.meta.url));

export function evaluateExpression(source: string, context: Record<string, unknown>) {
    const expression = source.replace(/^\s*\$\{\{\s*|\s*\}\}\s*$/g, '');
    const tokens = new Lexer(expression).lex().tokens;
    const ast = new Parser(tokens, Object.keys(context), []).parse();
    const values = JSON.parse(JSON.stringify(context), data.reviver) as data.Dictionary;

    return new Evaluator(ast, values).evaluate();
}

export function interpolate(source: string, context: Record<string, unknown>) {
    return source.replace(/\$\{\{([\s\S]*?)\}\}/g, (_match, expression: string) =>
        evaluateExpression(expression, context).coerceString()
    );
}

export function readWorkflow(filename: string): Workflow {
    const source = readFileSync(resolve(repositoryRoot, '.github/workflows', filename), 'utf8');
    const document = parseDocument(source);

    if (document.errors.length > 0) {
        throw new Error(
            `Cannot parse workflow ${filename}: ${document.errors.map((error) => error.message).join('; ')}`
        );
    }

    // Checked-in workflows are a trusted fixture boundary, not production input.
    return document.toJS() as Workflow;
}

export function readClassifierScript(filename: string) {
    const classify = readWorkflow(filename).jobs.changes?.steps.find(
        (step) => step.id === 'classify'
    );
    const script = classify?.with?.script;

    if (typeof script !== 'string') {
        throw new Error(`Workflow ${filename} does not define a string changes classifier script.`);
    }

    return script;
}

export async function runClassifier(
    filename: string,
    options: ClassifierOptions
): Promise<ClassifierResult> {
    const outputs: Record<string, string> = {};
    const paginateCalls: ClassifierResult['paginateCalls'] = [];
    const compareCalls: ClassifierResult['compareCalls'] = [];
    const listFilePages = options.listFilePages ?? [];
    let page = 0;

    const listFiles = async () => {
        if (options.listFilesError) {
            throw options.listFilesError;
        }

        return listFilePages[page++] ?? [];
    };

    const paginate = async (method: unknown, params: Record<string, unknown>) => {
        if (method !== listFiles) {
            throw new Error(`Unexpected paginated GitHub API method in ${filename}.`);
        }

        paginateCalls.push({ method, params });
        const files: unknown[] = [];

        do {
            files.push(...(await listFiles()));
        } while (page < listFilePages.length);

        return files;
    };

    const compareCommits = async (params: Record<string, unknown>) => {
        if (options.compareError) {
            throw options.compareError;
        }

        compareCalls.push(params);
        return { data: options.compareData ?? { files: [] } };
    };

    const github = {
        paginate,
        rest: {
            pulls: { listFiles },
            repos: { compareCommits },
        },
    };
    const core = {
        setOutput(name: string, value: string) {
            outputs[name] = value;
        },
    };
    const context = {
        eventName: options.eventName,
        repo: {
            owner: 'TouchAI-org',
            repo: 'TouchAI',
        },
        issue: {
            number: options.pullRequestNumber,
        },
        payload: options.payload ?? {},
    };
    const AsyncFunction = Object.getPrototypeOf(async function () {}).constructor as new (
        ...args: string[]
    ) => (...values: unknown[]) => Promise<void>;
    const classify = new AsyncFunction('context', 'github', 'core', readClassifierScript(filename));

    await classify(context, github, core);

    return { outputs, paginateCalls, compareCalls };
}

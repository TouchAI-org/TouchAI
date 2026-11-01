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

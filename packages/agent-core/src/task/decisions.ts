import type { JsonObject } from '@touchai/models/contracts';

import { snapshotValue } from '../checkpoints/snapshot';
import type { AgentEvent } from '../contracts/agent';
import type { DecisionAnswer, DecisionQuestion } from '../contracts/tool';

interface Entry {
    event: Extract<AgentEvent, { type: 'decision_required' }>;
    settle(value: boolean | DecisionAnswer[] | null): void;
    promise: Promise<boolean | DecisionAnswer[] | null>;
}

function validAnswers(
    value: unknown,
    questions: DecisionQuestion[]
): value is DecisionAnswer[] | null {
    if (value === null) return true;
    if (!Array.isArray(value) || value.length !== questions.length) return false;
    const indices = new Set<number>();
    return value.every((input: unknown) => {
        if (typeof input !== 'object' || input === null) return false;
        const answer = input as Partial<DecisionAnswer>;
        if (
            !Number.isInteger(answer.questionIndex) ||
            answer.questionIndex === undefined ||
            indices.has(answer.questionIndex)
        )
            return false;
        indices.add(answer.questionIndex);
        const question = questions[answer.questionIndex];
        if (
            !question ||
            typeof answer.skipped !== 'boolean' ||
            !Array.isArray(answer.selectedLabels)
        )
            return false;
        if (answer.otherText !== undefined && typeof answer.otherText !== 'string') return false;
        if (question.allowOther === false && answer.otherText?.trim()) return false;
        if (!question.multiSelect && answer.selectedLabels.length > 1) return false;
        if (new Set(answer.selectedLabels).size !== answer.selectedLabels.length) return false;
        return answer.selectedLabels.every(
            (label) =>
                typeof label === 'string' &&
                question.options.some((option) => option.label === label)
        );
    });
}

export class TaskDecisions {
    private attemptToken = '';
    private open = false;
    private closed = false;
    private counter = 0;
    private readonly entries = new Map<string, Entry>();

    constructor(
        private readonly taskId: string,
        private readonly emit: (event: AgentEvent) => void
    ) {}

    begin(attemptToken: string): void {
        this.end();
        if (this.closed) return;
        this.attemptToken = attemptToken;
        this.open = Boolean(attemptToken);
    }

    get pending(): readonly Extract<AgentEvent, { type: 'decision_required' }>[] {
        return [...this.entries.values()].map((entry) => entry.event);
    }

    approve(callId: string, payload: JsonObject, attemptToken: string): Promise<boolean> {
        return this.register(
            {
                type: 'decision_required',
                kind: 'approval',
                taskId: this.taskId,
                callId,
                decisionId: '',
                payload,
            },
            attemptToken
        ) as Promise<boolean>;
    }

    ask(
        callId: string,
        questions: DecisionQuestion[],
        attemptToken: string
    ): Promise<DecisionAnswer[] | null> {
        return this.register(
            {
                type: 'decision_required',
                kind: 'question',
                taskId: this.taskId,
                callId,
                decisionId: '',
                payload: questions,
            },
            attemptToken
        ) as Promise<DecisionAnswer[] | null>;
    }

    reply(decisionId: string, value: unknown): boolean {
        const found = [...this.entries.entries()].find(
            ([, entry]) => entry.event.decisionId === decisionId
        );
        if (!found || !this.open || this.closed) return false;
        const [key, entry] = found;
        if (
            entry.event.kind === 'approval'
                ? typeof value !== 'boolean'
                : !validAnswers(value, entry.event.payload)
        )
            return false;
        this.entries.delete(key);
        const answer = snapshotValue(value) as boolean | DecisionAnswer[] | null;
        entry.settle(answer);
        this.emit({
            type: 'decision_resolved',
            taskId: this.taskId,
            decisionId,
            callId: entry.event.callId,
            kind: entry.event.kind,
            value: answer,
        });
        return true;
    }

    end(): void {
        this.open = false;
        this.attemptToken = '';
        const previous = [...this.entries.values()];
        this.entries.clear();
        for (const entry of previous) {
            const value = entry.event.kind === 'approval' ? false : null;
            entry.settle(value);
            this.emit({
                type: 'decision_resolved',
                taskId: this.taskId,
                decisionId: entry.event.decisionId,
                callId: entry.event.callId,
                kind: entry.event.kind,
                value,
            });
        }
    }

    close(): void {
        this.closed = true;
        this.end();
    }

    private register(
        event: Extract<AgentEvent, { type: 'decision_required' }>,
        token: string
    ): Promise<boolean | DecisionAnswer[] | null> {
        const rejected = event.kind === 'approval' ? false : null;
        if (!this.open || this.closed || token !== this.attemptToken)
            return Promise.resolve(rejected);
        const key = `${event.kind}:${event.callId}`;
        const existing = this.entries.get(key);
        if (existing) return existing.promise;
        this.counter++;
        const observation = snapshotValue({
            ...event,
            decisionId: `${this.taskId}:${token}:${this.counter}`,
        });
        let settle!: Entry['settle'];
        const promise = new Promise<boolean | DecisionAnswer[] | null>((resolve) => {
            settle = resolve;
        });
        this.entries.set(key, { event: observation, promise, settle });
        this.emit(observation);
        return promise;
    }
}

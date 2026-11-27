import { ExternalAgentError } from './errors';

export const A2A_TERMINAL_STATES = new Set([3, 4, 5, 7]);
const A2A_INTERRUPTED_STATES = new Set([6, 8]);
const A2A_VALID_STATES = new Set([1, 2, 3, 4, 5, 6, 7, 8]);

type UnknownRecord = Record<string, unknown>;

function isRecord(value: unknown): value is UnknownRecord {
    return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function textFromPart(part: unknown): string {
    if (!isRecord(part)) throw new ExternalAgentError('invalid_response');
    if (typeof part.text === 'string') return part.text;
    const content = part.content;
    if (!isRecord(content) || content.$case !== 'text' || typeof content.value !== 'string')
        return '';
    return content.value;
}

function textFromParts(parts: unknown): string {
    if (!Array.isArray(parts)) throw new ExternalAgentError('invalid_response');
    return parts.map(textFromPart).join('');
}

export function messageText(message: unknown): string {
    if (
        !isRecord(message) ||
        typeof message.messageId !== 'string' ||
        !Array.isArray(message.parts)
    )
        throw new ExternalAgentError('invalid_response');
    if (message.role !== 1 && message.role !== 2) throw new ExternalAgentError('invalid_response');
    return textFromParts(message.parts);
}

function taskStatus(task: UnknownRecord): UnknownRecord {
    if (!isRecord(task.status) || typeof task.status.state !== 'number')
        throw new ExternalAgentError('invalid_response');
    if (!A2A_VALID_STATES.has(task.status.state)) throw new ExternalAgentError('invalid_response');
    return task.status;
}

export function taskArtifacts(task: unknown): Map<string, string> {
    if (!isRecord(task) || typeof task.id !== 'string' || !task.id)
        throw new ExternalAgentError('invalid_response');
    taskStatus(task);
    if (!Array.isArray(task.artifacts)) throw new ExternalAgentError('invalid_response');
    const artifacts = new Map<string, string>();
    for (const artifact of task.artifacts) {
        if (!isRecord(artifact) || typeof artifact.artifactId !== 'string')
            throw new ExternalAgentError('invalid_response');
        artifacts.set(artifact.artifactId, textFromParts(artifact.parts));
    }
    return artifacts;
}

export function taskState(task: unknown): number {
    if (!isRecord(task)) throw new ExternalAgentError('invalid_response');
    return taskStatus(task).state as number;
}

export function taskText(task: unknown): string {
    if (!isRecord(task)) throw new ExternalAgentError('invalid_response');
    const status = taskStatus(task);
    const segments: string[] = [];
    if (status.message !== undefined) segments.push(messageText(status.message));
    for (const text of taskArtifacts(task).values()) segments.push(text);
    return joinText(segments);
}

export function isTerminalTaskState(state: number): boolean {
    return A2A_TERMINAL_STATES.has(state);
}

export function isInterruptedTaskState(state: number): boolean {
    return A2A_INTERRUPTED_STATES.has(state);
}

function joinText(segments: readonly string[]): string {
    return segments.filter(Boolean).join('\n');
}

export class ExternalAgentStreamAccumulator {
    private readonly artifacts = new Map<string, string>();
    private readonly messages: string[] = [];
    private statusText = '';
    private taskId: string | undefined;
    terminal = false;
    state = 0;

    apply(response: unknown): string {
        if (!isRecord(response) || !isRecord(response.payload))
            throw new ExternalAgentError('invalid_response');
        const payload = response.payload;
        switch (payload.$case) {
            case 'task':
                return this.applyTask(payload.value);
            case 'message':
                this.messages.push(messageText(payload.value));
                this.terminal = true;
                this.state = 3;
                return this.text();
            case 'statusUpdate':
                return this.applyStatus(payload.value);
            case 'artifactUpdate':
                return this.applyArtifact(payload.value);
            default:
                throw new ExternalAgentError('invalid_response');
        }
    }

    currentTaskId(): string | undefined {
        return this.taskId;
    }

    private applyTask(value: unknown): string {
        if (!isRecord(value) || typeof value.id !== 'string' || !value.id)
            throw new ExternalAgentError('invalid_response');
        const state = taskState(value);
        this.artifacts.clear();
        for (const [id, text] of taskArtifacts(value)) this.artifacts.set(id, text);
        if (!isRecord(value.status) || value.status.message === undefined) this.statusText = '';
        else this.statusText = messageText(value.status.message);
        this.taskId = value.id;
        this.state = state;
        this.terminal = isTerminalTaskState(state);
        return this.text();
    }

    private applyStatus(value: unknown): string {
        if (!isRecord(value) || typeof value.taskId !== 'string')
            throw new ExternalAgentError('invalid_response');
        if (typeof value.taskId === 'string') this.taskId = value.taskId;
        if (!isRecord(value.status) || typeof value.status.state !== 'number')
            throw new ExternalAgentError('invalid_response');
        if (!A2A_VALID_STATES.has(value.status.state))
            throw new ExternalAgentError('invalid_response');
        this.state = value.status.state;
        if (value.status.message !== undefined) this.statusText = messageText(value.status.message);
        this.terminal = isTerminalTaskState(this.state);
        return this.text();
    }

    private applyArtifact(value: unknown): string {
        if (!isRecord(value) || typeof value.taskId !== 'string' || !isRecord(value.artifact))
            throw new ExternalAgentError('invalid_response');
        const artifact = value.artifact;
        if (typeof artifact.artifactId !== 'string')
            throw new ExternalAgentError('invalid_response');
        this.taskId = value.taskId;
        const chunk = textFromParts(artifact.parts);
        if (value.append === true) {
            this.artifacts.set(
                artifact.artifactId,
                `${this.artifacts.get(artifact.artifactId) ?? ''}${chunk}`
            );
        } else {
            this.artifacts.set(artifact.artifactId, chunk);
        }
        return this.text();
    }

    private text(): string {
        return joinText([this.statusText, ...this.messages, ...this.artifacts.values()]);
    }
}

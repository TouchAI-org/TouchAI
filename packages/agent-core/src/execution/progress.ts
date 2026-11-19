import { snapshotParts } from '../checkpoints/snapshot';
import type { AgentScope, OutputPart } from '../contracts/agent';
import type { ProgressTarget } from '../contracts/host';

export class LatestProgressWriter {
    private inFlight: Promise<void> | null = null;
    private pending: { parts: OutputPart[]; target: ProgressTarget } | null = null;
    private closed = false;
    private revision = 0;
    private signature: string | null = null;

    constructor(
        private readonly scope: AgentScope,
        private readonly persist: (parts: OutputPart[], target: ProgressTarget) => Promise<void>,
        private readonly onError: () => void
    ) {}

    enqueue(parts: OutputPart[]): void {
        if (this.closed) return;
        const normalized = snapshotParts(parts);
        if (!normalized.length) return;
        const signature = JSON.stringify(normalized);
        if (signature === this.signature) return;
        this.signature = signature;
        this.pending = {
            parts: normalized,
            target: { ...this.scope, step: this.scope.iteration, revision: ++this.revision },
        };
        this.pump();
    }

    close(): void {
        this.closed = true;
        this.pending = null;
    }

    async drain(): Promise<void> {
        while (this.inFlight) await this.inFlight;
    }

    private pump(): void {
        if (this.closed || this.inFlight || !this.pending) return;
        const current = this.pending;
        this.pending = null;
        this.inFlight = Promise.resolve()
            .then(() => this.persist(current.parts, current.target))
            .catch(() => {
                this.onError();
            })
            .finally(() => {
                this.inFlight = null;
                this.pump();
            });
    }
}

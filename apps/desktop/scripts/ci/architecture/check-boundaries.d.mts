export type GateIdentity = {
    ruleId?: string | null;
    fatal?: boolean;
};

export type GateMessage = GateIdentity & {
    line?: number;
    column?: number;
    message: string;
};

export type GateLintResult = {
    filePath: string;
    messages: GateMessage[];
};

export type GateReport = {
    lines: string[];
    errorCount: number;
    fileCount: number;
};

export const GATE_RULE_IDS: string[];

export const TARGETS: string[];

export function isGateMessage(message: GateIdentity): boolean;

export function collectGateReport(results: GateLintResult[]): GateReport;

export function parseCliArgs(argv: string[]): {
    projectRoot: string;
    targets: string[];
};

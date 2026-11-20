export interface DisplayStartupFailure {
    runStarted: boolean;
    exitCode: number | null;
    signal: string | null;
    logText: string;
}

export function shouldRetryDisplayStartupFailure(input: DisplayStartupFailure): boolean;

export interface MeasurementInvalidReasonInput {
    exitCode: number | null;
    signal: string | null;
    notificationFailures: number;
    samplerFailure: string | null;
}

export function measurementInvalidReasons(input: MeasurementInvalidReasonInput): string[];

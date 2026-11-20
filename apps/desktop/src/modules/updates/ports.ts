export type UpdatePhase =
    | 'check_started'
    | 'check_finished'
    | 'download_started'
    | 'download_finished'
    | 'install_handoff';
export type UpdateSource = 'background' | 'user' | 'other';
export type UpdateResult = 'success' | 'failure' | 'unavailable';

/** The controller reads only the captured handoff identity; instrumentation owns the token. */
export interface UpdateOperation {
    operation: { operationId: string };
    updateOperationId: string;
}
export interface UpdateOutcome {
    result: UpdateResult;
    source: UpdateSource;
    fromVersion?: string | null;
    toVersion?: string | null;
}
export interface AppUpdateAnalytics<Operation extends UpdateOperation = UpdateOperation> {
    beginUpdateOperation(updateOperationId?: string): Promise<Operation>;
    trackUpdateTransition(
        operation: Operation,
        phase: UpdatePhase,
        outcome: UpdateOutcome
    ): Promise<void>;
    finishUpdateOperation(operation: Operation): Promise<void>;
}

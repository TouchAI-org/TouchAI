export type BuiltInToolRiskLevel = 'low' | 'medium' | 'high';
export type BuiltInToolLogStatus =
    | 'pending'
    | 'awaiting_approval'
    | 'approved'
    | 'rejected'
    | 'success'
    | 'error'
    | 'timeout'
    | 'cancelled';
export interface BuiltInToolEntity {
    id: number;
    tool_id: string;
    display_name: string;
    description: string | null;
    enabled: number;
    risk_level: BuiltInToolRiskLevel;
    config_json: string | null;
    last_used_at: string | null;
    created_at: string;
    updated_at: string;
}

export interface BuiltInToolLogEntity {
    id: number;
    tool_id: string;
    tool_call_id: string;
    session_id: number | null;
    message_id: number | null;
    iteration: number;
    input: string;
    output: string | null;
    status: BuiltInToolLogStatus;
    approval_state: string | null;
    approval_summary: string | null;
    duration_ms: number | null;
    error_message: string | null;
    created_at: string;
}

export interface BuiltInToolUpdateData {
    enabled?: 0 | 1;
    config_json?: string | null;
}

export interface FindBuiltInToolLogsOptions {
    limit?: number;
    offset?: number;
}

/** 列表展示用的日志摘要，不含完整 input/output。 */
export interface BuiltInToolLogSummary {
    id: number;
    tool_call_id: string | null;
    tool_name: string;
    session_id: number | null;
    message_id: number;
    created_at: string;
    status: BuiltInToolLogStatus;
    duration_ms: number | null;
    input_preview: string | null;
    output_length: number;
}

export interface BuiltInToolQueries {
    findAllBuiltInTools: () => Promise<BuiltInToolEntity[]>;
    updateBuiltInTool: (
        id: number,
        patch: BuiltInToolUpdateData
    ) => Promise<BuiltInToolEntity | undefined>;
    updateBuiltInTools: (
        ids: number[],
        patch: BuiltInToolUpdateData
    ) => Promise<BuiltInToolEntity[]>;
    findBuiltInToolLogsByToolId: (
        toolId: string,
        options?: FindBuiltInToolLogsOptions
    ) => Promise<BuiltInToolLogEntity[]>;
    /** 列表轻量投影。 */
    findBuiltInToolLogSummariesByToolId: (
        toolId: string,
        options?: FindBuiltInToolLogsOptions
    ) => Promise<BuiltInToolLogSummary[]>;
    /** 展开时按主键读取完整正文。 */
    findBuiltInToolLogById: (id: number) => Promise<BuiltInToolLogEntity | undefined>;
}

export const NATIVE_SERVICE_DIR: string;
export const RUST_HANDLER_FILE: string;
export const CARGO_TOML_FILE: string;

export function stripRustComments(source: string): string;

export function readRustCommands(projectRoot?: string): Set<string>;

export function readPluginNames(projectRoot?: string): Set<string>;

export function readPluginCommandWhitelist(
    whitelistFile?: string
): Record<string, { source?: string; reason?: string }>;

export function collectNativeServiceInvokes(projectRoot?: string): {
    invokes: { command: string; file: string; line: number }[];
    dynamic: { file: string; line: number }[];
};

export function validatePluginCommandWhitelist(
    projectRoot: string,
    whitelist: Record<string, { source?: unknown; reason?: unknown }>,
    pluginNames: Set<string>,
    nativeInvokes?: { command: string; file: string; line: number }[]
): string[];

export function checkIpcCommands(options?: { projectRoot?: string; whitelistFile?: string }): {
    invokes: { command: string; file: string; line: number }[];
    dynamic: { file: string; line: number }[];
    rustCommandCount: number;
    pluginNames: string[];
    pluginCommands: string[];
    whitelistErrors: string[];
    unknown: { command: string; file: string; line: number; reason: string }[];
};

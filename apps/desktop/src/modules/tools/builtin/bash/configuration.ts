import { parseToolConfigJson } from '../../execution/schema';
import { type BashToolConfig, bashToolConfigSchema, DEFAULT_BASH_TOOL_CONFIG } from './constants';

export function parseBashToolConfig(configJson: string | null): BashToolConfig {
    return parseToolConfigJson(bashToolConfigSchema, configJson, DEFAULT_BASH_TOOL_CONFIG);
}

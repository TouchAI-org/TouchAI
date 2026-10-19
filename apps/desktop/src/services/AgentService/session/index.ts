// Copyright (c) 2026. Qian Cheng. Licensed under GPL v3

/**
 * `session` 层负责会话级真相源的读取与整理。
 *
 * 它处理会话列表、历史记录、标题生成、历史消息重组，
 * 但不承担正在运行任务的生命周期控制。
 */
export type { SessionHistoryPage } from './history';
export {
    buildSessionHistory,
    buildSessionHistoryFromData,
    loadSessionHistory,
    loadSessionHistoryPage,
} from './history';
export type { SessionData, SessionDataPage } from './manager';
export {
    createSession,
    dismissSessionTerminalStatus,
    getSessionData,
    getSessionDataPage,
    listSessions,
} from './manager';
export { buildSessionTitle } from './title';
export { loadSessionTransportMessages } from './transport';

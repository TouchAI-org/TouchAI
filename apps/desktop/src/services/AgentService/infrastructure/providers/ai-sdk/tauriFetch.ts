// Copyright (c) 2026. Qian Cheng. Licensed under GPL v3

/**
 * 兼容旧引用路径：HTTP 实现已迁到 `@services/HttpService`。
 * 这里只做转发，避免出现第二份实现。
 */
export { createTauriFetch } from '@services/HttpService';

// Copyright (c) 2026. Qian Cheng. Licensed under GPL v3

import type { WindowInfo } from '@/contracts/popup';
import type { PopupPositionStrategy, PopupType } from '@/contracts/popupManifest';

export type * from '@/contracts/popup';
export type { PopupPositionStrategy, PopupType } from '@/contracts/popupManifest';

/**
 * 位置计算函数类型。
 */
export type PositionCalculator = (
    triggerElement: HTMLElement,
    mainWindow: WindowInfo,
    dimensions: { width: number; height: number }
) => { x: number; y: number };

/**
 * Popup 服务侧配置接口。
 */
export interface PopupConfig<TData = unknown> {
    /** 唯一标识符 */
    id: PopupType;
    /** 窗口宽度（逻辑像素） */
    width: number;
    /** 窗口高度（逻辑像素） */
    height: number;
    /** 窗口最小高度（逻辑像素），用于内容不足时保持最低高度 */
    minHeight?: number;
    /** 声明式定位策略 */
    positionStrategy: PopupPositionStrategy;
    /** 位置计算函数 */
    calculatePosition: PositionCalculator;
    /** 可选的数据验证器 */
    dataValidator?: (data: unknown) => data is TData;
}

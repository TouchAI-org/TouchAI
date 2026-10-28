// Copyright (c) 2026. 千诚. Licensed under GPL v3.
import './utils/early-errors';
import '@styles/tailwind.css';

import { log } from '@services/ObservabilityService';

import { initializeApp } from './bootstrap';
import { installLongTaskProbe } from './utils/longTaskProbe';
import { initializeDesktopShell } from './utils/windowChrome';

// 先标记平台外壳样式，避免首帧画出直角再变成圆角
initializeDesktopShell();

// 开发期观测主线程长任务（定位"卡几秒"用）
installLongTaskProbe();

// 运行应用初始化
initializeApp().catch((error) => log.error(error));

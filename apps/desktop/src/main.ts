// Copyright (c) 2026. 千诚. Licensed under GPL v3.

import '@styles/tailwind.css';

import { initializeApp } from './bootstrap';
import { initializeDesktopShell } from './utils/windowChrome';

// 先标记平台外壳样式，避免首帧画出直角再变成圆角
initializeDesktopShell();

// 运行应用初始化
initializeApp().catch(console.error);

// Copyright (c) 2026. 千诚. Licensed under GPL v3.
import '@styles/tailwind.css';

import { log } from '@/platform/diagnostics';
import { installEarlyErrors } from '@/platform/diagnostics/early-errors';

import { initializeDesktopShell } from './platform/windows/chrome';

installEarlyErrors();
// 先标记平台外壳样式，避免首帧画出直角再变成圆角
initializeDesktopShell();

// 运行应用初始化
void import('./app/bootstrap')
    .then(({ initializeApp }) => initializeApp())
    .catch((error) => log.error(error));

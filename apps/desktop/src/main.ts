// Copyright (c) 2026. 鍗冭瘹. Licensed under GPL v3.
import './utils/early-errors';
import '@styles/tailwind.css';

import { log } from '@services/ObservabilityService';

import { initializeApp } from './bootstrap';
import { installLongTaskProbe } from './utils/longTaskProbe';
import { initializeDesktopShell } from './utils/windowChrome';

// 鍏堟爣璁板钩鍙板澹虫牱寮忥紝閬垮厤棣栧抚鐢诲嚭鐩磋鍐嶅彉鎴愬渾瑙?initializeDesktopShell();

// 寮€鍙戞湡瑙傛祴涓荤嚎绋嬮暱浠诲姟锛堝畾浣?鍗″嚑绉?鐢級
installLongTaskProbe();

// 杩愯搴旂敤鍒濆鍖?initializeApp().catch((error) => log.error(error));

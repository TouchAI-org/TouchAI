// Copyright (c) 2025. 千诚. Licensed under GPL v3.

import '@styles/tailwind.css';

import { setupLinkInterceptor } from '@utils/linkInterceptor';
import { initializeLogger } from '@utils/logger.ts';
import { createApp } from 'vue';

import App from './App.vue';
import router from './router';

/**
 * 初始化应用
 */
async function initializeApp() {
    // 1. 初始化日志挂载
    initializeLogger();

    // 2. 启用链接拦截器（禁止外部链接跳转）
    setupLinkInterceptor();

    // 3. 禁止右键菜单（全局）
    document.addEventListener('contextmenu', (e) => e.preventDefault());

    // 4. 创建并挂载 Vue 应用
    const app = createApp(App);
    app.use(router);
    app.mount('#app');
}

// 运行应用初始化
initializeApp().catch(console.error);

// Copyright (c) 2026. 千诚. Licensed under GPL v3.

import { createRouter, createWebHashHistory } from 'vue-router';

const routes = [
    {
        path: '/',
        name: 'Search',
        component: () => import('@/views/SearchView/index.vue'),
    },
    {
        path: '/settings',
        name: 'Settings',
        component: () => import('@/views/SettingsView/index.vue'),
    },
    {
        path: '/tray-menu',
        name: 'TrayMenu',
        component: () => import('@/views/TrayView/index.vue'),
    },
    {
        path: '/computer-use-glow',
        name: 'ComputerUseGlow',
        component: () => import('@/views/ComputerUseGlowView/index.vue'),
    },
];

const router = createRouter({
    history: createWebHashHistory(),
    routes,
});

export default router;

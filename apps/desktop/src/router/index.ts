// Copyright (c) 2026. 千诚. Licensed under GPL v3.

import { createRouter, createWebHistory } from 'vue-router';

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
        path: '/popup',
        name: 'Popup',
        component: () => import('@/views/PopupView/index.vue'),
    },
];

const router = createRouter({
    history: createWebHistory(),
    routes,
});

export default router;

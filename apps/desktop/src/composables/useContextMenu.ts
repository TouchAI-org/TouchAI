// Copyright (c) 2026. 千诚. Licensed under GPL v3.

import type { AppIconName } from '@components/appIconMap';
import ContextMenuVue from '@components/ContextMenu.vue';
import { type App, type ComponentPublicInstance, createApp, onScopeDispose } from 'vue';

export interface ContextMenuItem {
    key: string;
    label: string;
    icon?: AppIconName;
    danger?: boolean;
}

type ContextMenuItemsSource = ContextMenuItem[] | (() => ContextMenuItem[]);

let contextMenuSequence = 0;

export function useContextMenu<T = void>(
    items: ContextMenuItemsSource,
    onSelect: (key: string, context: T) => void,
    onClose?: () => void
) {
    type MenuInstance = {
        id: string;
        app: App | null;
        container: HTMLDivElement;
        component: (ComponentPublicInstance & { close?: () => void }) | null;
        keydownHandler: ((event: KeyboardEvent) => void) | null;
        activeIndex: number;
        closing: boolean;
        closeNotified: boolean;
        cleanupTimer: ReturnType<typeof setTimeout> | null;
        context: T | undefined;
        animationFrame: number | null;
        disposed: boolean;
    };

    let active: MenuInstance | null = null;

    const detachKeyboard = (instance: MenuInstance) => {
        if (instance.keydownHandler) {
            document.removeEventListener('keydown', instance.keydownHandler, true);
            instance.keydownHandler = null;
        }
    };

    const notifyClose = (instance: MenuInstance) => {
        if (!instance.closeNotified) {
            instance.closeNotified = true;
            onClose?.();
        }
    };

    const dispose = (instance: MenuInstance) => {
        if (instance.disposed) return;
        instance.disposed = true;
        if (instance.cleanupTimer !== null) {
            clearTimeout(instance.cleanupTimer);
            instance.cleanupTimer = null;
        }
        if (instance.animationFrame !== null) {
            cancelAnimationFrame(instance.animationFrame);
            instance.animationFrame = null;
        }
        detachKeyboard(instance);
        instance.app?.unmount();
        instance.app = null;
        instance.component = null;
        instance.container.remove();
        if (active === instance) active = null;
    };

    const beginClose = (instance: MenuInstance, notify = true) => {
        if (instance.disposed) return;
        if (notify) notifyClose(instance);
        detachKeyboard(instance);
        if (instance.closing) return;
        instance.closing = true;
        // The timer is a safety net for reduced motion, animation cancellation,
        // test DOMs, and app shutdowns where animationend cannot be delivered.
        instance.cleanupTimer = setTimeout(() => dispose(instance), 600);
    };

    /** 获取当前菜单项元素列表。Reka UI teleports content to body. */
    function getMenuItems(instance: MenuInstance): HTMLElement[] {
        const menuEl = document.querySelector(
            `[data-context-menu-id="${instance.id}"][role="menu"]`
        );
        if (!menuEl) return [];
        return Array.from(menuEl.querySelectorAll('[role="menuitem"]')) as HTMLElement[];
    }

    /** 更新视觉高亮：手动设置 data-highlighted 属性。 */
    function updateHighlight(instance: MenuInstance) {
        const items = getMenuItems(instance);
        if (items.length === 0) return;
        instance.activeIndex = Math.min(instance.activeIndex, items.length - 1);
        items.forEach((el, index) => {
            if (index === instance.activeIndex) {
                el.setAttribute('data-highlighted', '');
                el.scrollIntoView?.({ block: 'nearest' });
            } else {
                el.removeAttribute('data-highlighted');
            }
        });
    }

    /** 选中当前高亮项。 */
    function selectActive(instance: MenuInstance) {
        const items = getMenuItems(instance);
        const el = items[instance.activeIndex];
        if (!el) return;
        el.dispatchEvent(new PointerEvent('pointerdown', { bubbles: true }));
        el.dispatchEvent(new PointerEvent('pointerup', { bubbles: true }));
        el.dispatchEvent(new MouseEvent('click', { bubbles: true }));
    }

    function resolveItems(): ContextMenuItem[] {
        return typeof items === 'function' ? items() : items;
    }

    const open = (event: MouseEvent, value?: T) => {
        event.preventDefault();
        if (active) dispose(active);

        const instance: MenuInstance = {
            id: `touchai-context-menu-${++contextMenuSequence}`,
            app: null,
            container: document.createElement('div'),
            component: null,
            keydownHandler: null,
            activeIndex: 0,
            closing: false,
            closeNotified: false,
            cleanupTimer: null,
            context: value,
            animationFrame: null,
            disposed: false,
        };
        active = instance;
        document.body.appendChild(instance.container);

        instance.app = createApp(ContextMenuVue, {
            x: event.clientX,
            y: event.clientY,
            items: resolveItems(),
            menuId: instance.id,
            onSelect: (key: string) => {
                if (!instance.disposed) onSelect(key, instance.context as T);
            },
            onClose: () => beginClose(instance),
            onClosed: () => dispose(instance),
        });
        instance.component = instance.app.mount(instance.container) as MenuInstance['component'];

        // 捕获阶段优先于主应用键盘路由. It is removed as soon as closing
        // starts, so the exit animation never traps focus or keystrokes.
        instance.keydownHandler = (event: KeyboardEvent) => {
            if (active !== instance || instance.closing) return;
            const menuItems = getMenuItems(instance);
            switch (event.key) {
                case 'Escape':
                case 'Esc':
                    event.preventDefault();
                    event.stopPropagation();
                    instance.component?.close?.();
                    break;
                case 'ArrowUp':
                    event.preventDefault();
                    event.stopPropagation();
                    if (menuItems.length > 0) {
                        instance.activeIndex =
                            (instance.activeIndex - 1 + menuItems.length) % menuItems.length;
                        updateHighlight(instance);
                    }
                    break;
                case 'ArrowDown':
                    event.preventDefault();
                    event.stopPropagation();
                    if (menuItems.length > 0) {
                        instance.activeIndex = (instance.activeIndex + 1) % menuItems.length;
                        updateHighlight(instance);
                    }
                    break;
                case 'Enter':
                    event.preventDefault();
                    event.stopPropagation();
                    selectActive(instance);
                    break;
                default:
                    event.stopPropagation();
                    break;
            }
        };
        document.addEventListener('keydown', instance.keydownHandler, true);

        instance.animationFrame = requestAnimationFrame(() => {
            instance.animationFrame = null;
            if (!instance.disposed && !instance.closing) updateHighlight(instance);
        });
    };

    const close = () => {
        if (!active) return;
        if (active.component?.close) active.component.close();
        else {
            notifyClose(active);
            dispose(active);
        }
    };

    onScopeDispose(() => {
        if (active) dispose(active);
        active = null;
    });

    return { open, close };
}

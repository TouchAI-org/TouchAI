// Copyright (c) 2026. 千诚. Licensed under GPL v3.

import type { AppIconName } from '@components/appIconMap';
import ContextMenuVue from '@components/ContextMenu.vue';
import { type App, createApp, ref } from 'vue';

export interface ContextMenuItem {
    key: string;
    label: string;
    icon?: AppIconName;
    danger?: boolean;
}

type ContextMenuItemsSource = ContextMenuItem[] | (() => ContextMenuItem[]);

export function useContextMenu<T = void>(
    items: ContextMenuItemsSource,
    onSelect: (key: string, context: T) => void,
    onClose?: () => void
) {
    const context = ref<T | undefined>(undefined) as { value: T | undefined };
    let mountedApp: App | null = null;
    let container: HTMLDivElement | null = null;
    let keydownHandler: ((e: KeyboardEvent) => void) | null = null;
    let activeIndex = 0;

    const cleanup = (options: { notify?: boolean } = {}) => {
        const hadMenu = keydownHandler !== null || mountedApp !== null || container !== null;
        if (keydownHandler) {
            document.removeEventListener('keydown', keydownHandler, true);
            keydownHandler = null;
        }
        if (mountedApp) {
            mountedApp.unmount();
            mountedApp = null;
        }
        if (container) {
            container.remove();
            container = null;
        }
        activeIndex = 0;

        if (hadMenu && options.notify !== false) {
            onClose?.();
        }
    };

    /** 获取当前菜单项元素列表。 */
    function getMenuItems(): HTMLElement[] {
        if (!container) return [];
        const menuEl = container.querySelector('[role="menu"]');
        if (!menuEl) return [];
        return Array.from(menuEl.querySelectorAll('[role="menuitem"]')) as HTMLElement[];
    }

    /** 更新视觉高亮：手动设置 data-highlighted 属性。 */
    function updateHighlight() {
        const items = getMenuItems();
        if (items.length === 0) return;
        activeIndex = Math.min(activeIndex, items.length - 1);
        items.forEach((el, i) => {
            if (i === activeIndex) {
                el.setAttribute('data-highlighted', '');
                el.scrollIntoView({ block: 'nearest' });
            } else {
                el.removeAttribute('data-highlighted');
            }
        });
    }

    /** 选中当前高亮项。 */
    function selectActive() {
        const items = getMenuItems();
        const el = items[activeIndex];
        if (!el) return;
        el.dispatchEvent(new PointerEvent('pointerdown', { bubbles: true }));
        el.dispatchEvent(new PointerEvent('pointerup', { bubbles: true }));
        el.dispatchEvent(new MouseEvent('click', { bubbles: true }));
    }

    function resolveItems(): ContextMenuItem[] {
        return typeof items === 'function' ? items() : items;
    }

    const open = (event: MouseEvent, ctx?: T) => {
        event.preventDefault();
        cleanup({ notify: false });

        context.value = ctx;
        activeIndex = 0;
        container = document.createElement('div');
        document.body.appendChild(container);

        mountedApp = createApp(ContextMenuVue, {
            x: event.clientX,
            y: event.clientY,
            items: resolveItems(),
            onSelect: (key: string) => {
                if (context.value !== undefined) {
                    onSelect(key, context.value);
                }
                cleanup();
            },
            onClose: cleanup,
        });
        mountedApp.mount(container);

        // 在 document 上以捕获模式监听键盘，优先于主应用的键盘路由。
        keydownHandler = (e: KeyboardEvent) => {
            const menuEl = document.querySelector('[role="menu"]');
            const menuItems = menuEl?.querySelectorAll('[role="menuitem"]');
            const itemCount = menuItems?.length ?? 0;

            switch (e.key) {
                case 'Escape':
                case 'Esc':
                    e.preventDefault();
                    e.stopPropagation();
                    cleanup();
                    break;
                case 'ArrowUp':
                    e.preventDefault();
                    e.stopPropagation();
                    if (itemCount > 0) {
                        activeIndex = (activeIndex - 1 + itemCount) % itemCount;
                        updateHighlight();
                    }
                    break;
                case 'ArrowDown':
                    e.preventDefault();
                    e.stopPropagation();
                    if (itemCount > 0) {
                        activeIndex = (activeIndex + 1) % itemCount;
                        updateHighlight();
                    }
                    break;
                case 'Enter':
                    e.preventDefault();
                    e.stopPropagation();
                    selectActive();
                    break;
                default:
                    // 其它键不拦截，但阻止传播到主应用。
                    e.stopPropagation();
                    break;
            }
        };
        document.addEventListener('keydown', keydownHandler, true);

        // 初始高亮第一项。
        requestAnimationFrame(() => updateHighlight());
    };

    const close = () => {
        cleanup();
    };

    return { open, close };
}

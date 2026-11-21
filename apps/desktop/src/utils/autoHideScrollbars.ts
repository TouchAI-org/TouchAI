// Copyright (c) 2026. 千诚. Licensed under GPL v3.

/** Keep native scrollports, including dynamically mounted menus and textareas.
 * Self-contained so the same policy can run inside isolated widget documents. */
export function installAutoHideScrollbars(root: Document): () => void {
    const view = root.defaultView;
    if (!view) return () => {};

    const active = new Map<Element, number>();
    const fading = new Map<Element, Animation>();
    let pressed: Element | null = null;
    const attribute = 'data-scrollbar-scrolling';

    function cancelFade(element: Element) {
        fading.get(element)?.cancel();
        fading.delete(element);
    }

    function hide(element: Element) {
        if (pressed === element) pressed = null;
        active.delete(element);
        element.removeAttribute(attribute);
        if (!element.isConnected || typeof element.animate !== 'function') return;
        const style = view!.getComputedStyle(element);
        const reducedMotion =
            root.documentElement.hasAttribute('data-reduced-motion') ||
            view!.matchMedia('(prefers-reduced-motion: reduce)').matches;
        if (reducedMotion) return;
        const duration =
            (parseFloat(style.getPropertyValue('--duration-quick-base')) || 150) *
            (parseFloat(style.getPropertyValue('--motion-duration-scale')) || 1);
        const animation = element.animate(
            {
                '--scrollbar-thumb-color': [
                    style.getPropertyValue('--color-scrollbar-thumb').trim() || 'transparent',
                    'transparent',
                ],
                '--scrollbar-thumb-hover-color': [
                    style.getPropertyValue('--color-scrollbar-thumb-hover').trim() || 'transparent',
                    'transparent',
                ],
            },
            { duration, easing: style.getPropertyValue('--ease-smooth-out').trim() || 'ease-out' }
        );
        fading.set(element, animation);
        const settled = () => {
            if (fading.get(element) === animation) fading.delete(element);
        };
        void animation.finished.then(settled, settled);
    }

    function scheduleHide(element: Element) {
        view!.clearTimeout(active.get(element));
        active.set(
            element,
            view!.setTimeout(() => {
                if (pressed === element && element.isConnected) return;
                hide(element);
            }, 700)
        );
    }

    function onScroll(event: Event) {
        const element = event.target === root ? root.scrollingElement : event.target;
        if (!(element instanceof Element)) return;
        cancelFade(element);
        if (!element.hasAttribute(attribute)) element.setAttribute(attribute, '');
        scheduleHide(element);
    }

    function onPointerDown(event: Event) {
        const element = event.target;
        // Record every press: an idle thumb that is dragged must stay visible even when
        // the user holds it still past the idle delay, before the first scroll fires.
        if (element instanceof Element) pressed = element;
    }

    function releasePointer() {
        if (pressed && active.has(pressed)) scheduleHide(pressed);
        pressed = null;
    }

    root.addEventListener('scroll', onScroll, { capture: true, passive: true });
    root.addEventListener('pointerdown', onPointerDown, { capture: true, passive: true });
    root.addEventListener('pointerup', releasePointer, { capture: true, passive: true });
    root.addEventListener('pointercancel', releasePointer, { capture: true, passive: true });
    view.addEventListener('blur', releasePointer);

    return () => {
        root.removeEventListener('scroll', onScroll, true);
        root.removeEventListener('pointerdown', onPointerDown, true);
        root.removeEventListener('pointerup', releasePointer, true);
        root.removeEventListener('pointercancel', releasePointer, true);
        view.removeEventListener('blur', releasePointer);
        pressed = null;
        for (const [element, timer] of active) {
            view.clearTimeout(timer);
            element.removeAttribute(attribute);
        }
        active.clear();
        for (const element of fading.keys()) cancelFade(element);
    };
}

import { computed, nextTick, onMounted, ref } from 'vue';

const SETTINGS_MODAL_ROOT_ID = 'settings-modal-root';

/**
 * Dialogs can mount before the settings shell's portal target exists. Resolve
 * it after the current mount flush so the backdrop stays inside the visible
 * shell instead of covering the transparent window gutter.
 */
export function useSettingsModalTarget() {
    const portalTarget = ref<string>();
    const inSettingsShell = computed(() => portalTarget.value !== undefined);

    const resolveTarget = (): void => {
        portalTarget.value = document.getElementById(SETTINGS_MODAL_ROOT_ID)
            ? `#${SETTINGS_MODAL_ROOT_ID}`
            : undefined;
    };

    /*
     * Dialogs open after the settings shell has mounted. Resolve once after
     * mount and once after the current flush; keeping an observer here would
     * add lifetime work to every dialog for a target that is created with the
     * shell and removed with it.
     */
    onMounted(() => {
        resolveTarget();
        void nextTick(resolveTarget);
    });

    return { portalTarget, inSettingsShell };
}

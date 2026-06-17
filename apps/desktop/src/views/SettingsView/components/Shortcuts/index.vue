<script setup lang="ts">
    import { t } from '@/i18n';

    import GeneralShortcutSettings from '../General/GeneralShortcutSettings.vue';
    import SearchShortcutSettings from '../General/SearchShortcutSettings.vue';

    defineOptions({
        name: 'SettingsShortcutsSection',
    });
</script>

<template>
    <div class="settings-page" data-testid="settings-shortcuts-section">
        <div class="settings-section-stack">
            <header class="settings-page-header flex items-start gap-4">
                <div class="max-w-2xl min-w-0">
                    <h1 class="settings-page-title" data-testid="shortcuts-settings-title">
                        {{ t('settings.nav.shortcuts.label') }}
                    </h1>
                    <p class="settings-section-description">
                        {{ t('settings.nav.shortcuts.description') }}
                    </p>
                </div>
            </header>

            <section class="space-y-4">
                <h2 class="settings-section-title">
                    {{ t('settings.general.globalShortcutGroup') }}
                </h2>
                <GeneralShortcutSettings />
            </section>

            <section class="mt-10 space-y-4">
                <div>
                    <h2 class="settings-section-title">
                        {{ t('settings.general.searchShortcuts') }}
                    </h2>
                    <p class="settings-section-description">
                        {{ t('settings.general.searchShortcutsDescription') }}
                    </p>
                </div>
                <SearchShortcutSettings />
            </section>
        </div>
    </div>
</template>

<script setup lang="ts">
    import ModelPreferences from '../General/components/ModelPreferences.vue';

    defineOptions({
        name: 'SettingsModelPreferencesSection',
    });
</script>

<template>
    <div class="settings-page" data-testid="settings-model-preferences-section">
        <div class="settings-section-stack">
            <ModelPreferences />
        </div>
    </div>
</template>

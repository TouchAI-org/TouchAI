<!-- Copyright (c) 2026. 千诚. Licensed under GPL v3 -->

<script setup lang="ts">
    defineOptions({
        name: 'ProviderFormDialog',
    });

    import CustomSelect from '@components/CustomSelect.vue';
    import DialogShell from '@components/DialogShell.vue';
    import PasswordInput from '@components/PasswordInput.vue';
    import { Button } from '@components/ui/button';
    import { Input } from '@components/ui/input';
    import { useAlert } from '@composables/useAlert';
    import type { NewProvider, Provider, ProviderDriver } from '@database/schema';
    import { computed, ref, watch } from 'vue';

    import { t } from '@/i18n';
    import { aiService } from '@/services/AgentService';
    import {
        getProviderDriverDefinition,
        providerDriverDefinitions,
    } from '@/services/AgentService/infrastructure/providers';

    /*
     * 新增与编辑服务商的表单原本是两个文件，名称 / 类型 / 基址预览三段
     * 逐字相同，差异全部由 mode 决定：
     *
     *   1. 标题          新增 text-base font-bold / 编辑 text-[15px] font-medium
     *   2. 提交按钮文案   create / save
     *   3. 字段集合       新增多出 API Key 与「创建后启用」；编辑只改名称与类型
     *   4. 基址预览来源   新增取表单输入 / 编辑取已保存的 provider
     *
     * 「创建后启用」的复选框 id 在页面上是全局唯一的，这里保持固定值不变，
     * 因为同一时刻每个窗口只会挂载一个该对话框。
     */
    interface Props {
        mode: 'create' | 'edit';
        provider?: Provider;
        open?: boolean;
    }

    const props = withDefaults(defineProps<Props>(), {
        provider: undefined,
        open: true,
    });

    const emit = defineEmits<{
        create: [data: NewProvider];
        update: [data: Partial<Provider>];
        cancel: [];
        closed: [];
    }>();

    const alert = useAlert();

    const rawProviderLogos = import.meta.glob<{ default: string }>('@assets/logos/providers/*', {
        eager: true,
    });
    const providerLogos: Record<string, string> = {};
    for (const [path, mod] of Object.entries(rawProviderLogos)) {
        const fileName = path.split('/').pop();
        if (fileName && mod.default) {
            providerLogos[fileName] = mod.default;
        }
    }

    const driverOptions = providerDriverDefinitions.map((definition) => ({
        label: definition.label,
        value: definition.driver,
        iconSrc: providerLogos[definition.logo] || '',
    }));

    interface ProviderForm {
        name: string;
        driver: ProviderDriver;
        logo: string;
        api_endpoint: string;
        api_key: string;
        config_json: string | null;
        enabled: number;
    }

    const formFromProvider = (provider: Provider): ProviderForm => ({
        name: provider.name,
        driver: provider.driver as ProviderDriver,
        logo: provider.logo,
        api_endpoint: provider.api_endpoint,
        api_key: provider.api_key ?? '',
        config_json: provider.config_json ?? null,
        enabled: provider.enabled,
    });

    const emptyForm = (): ProviderForm => ({
        name: '',
        driver: 'openai' as ProviderDriver,
        api_endpoint: '',
        api_key: '',
        config_json: null,
        logo: getProviderDriverDefinition('openai').logo,
        enabled: 1,
    });

    const buildForm = () =>
        props.mode === 'edit' && props.provider ? formFromProvider(props.provider) : emptyForm();

    const form = ref<ProviderForm>(buildForm());

    const resetForm = () => {
        form.value = buildForm();
    };

    // 编辑态：provider 身份变化时重新填充
    watch(
        () => props.provider,
        (next) => {
            if (props.mode === 'edit' && next) {
                form.value = formFromProvider(next);
            }
        }
    );
    // 每次真正打开时重置，避免上一次取消的编辑残留
    watch(
        () => props.open,
        (open, wasOpen) => {
            if (open && wasOpen === false) resetForm();
        }
    );

    const selectedDriverDefinition = computed(() =>
        getProviderDriverDefinition(form.value.driver || 'openai')
    );

    const trimmedProviderName = computed(() => form.value.name.trim());
    const trimmedApiEndpoint = computed(() => form.value.api_endpoint.trim());

    /** 基址预览：新增态用表单输入，编辑态用已保存的 provider 字段 */
    const previewEndpoint = computed(() =>
        props.mode === 'edit' && props.provider
            ? props.provider.api_endpoint
            : trimmedApiEndpoint.value
    );
    const previewApiKey = computed(() =>
        props.mode === 'edit' && props.provider
            ? (props.provider.api_key ?? undefined)
            : form.value.api_key || undefined
    );
    const previewConfigJson = computed(() =>
        props.mode === 'edit' && props.provider
            ? props.provider.config_json
            : form.value.config_json
    );

    const apiTargets = computed(() =>
        aiService
            .createProviderInstance(
                form.value.driver || 'openai',
                previewEndpoint.value,
                previewApiKey.value,
                previewConfigJson.value
            )
            .getApiTargets()
    );

    const generationApiPreview = computed(() => apiTargets.value.generationTarget);

    const shouldShowGenerationApiPreview = computed(
        () => previewEndpoint.value.length > 0 && generationApiPreview.value.length > 0
    );

    const handleDriverChange = () => {
        form.value.logo = selectedDriverDefinition.value.logo;
    };

    const title = computed(() =>
        props.mode === 'create'
            ? t('settings.ai.addProvider.title')
            : t('settings.ai.editProvider.title')
    );

    const titleClass = computed(() =>
        props.mode === 'create'
            ? 'mb-5 text-base font-bold text-neutral-950'
            : 'mb-5 text-[15px] font-medium text-neutral-950'
    );

    const submitLabel = computed(() =>
        props.mode === 'create' ? t('common.create') : t('common.save')
    );

    const handleSave = () => {
        if (props.mode === 'create') {
            if (!trimmedProviderName.value || !trimmedApiEndpoint.value) {
                alert.error(t('settings.ai.enterProviderNameAndEndpoint'));
                return;
            }
            emit('create', {
                name: trimmedProviderName.value,
                driver: form.value.driver,
                api_endpoint: trimmedApiEndpoint.value,
                api_key: form.value.api_key || null,
                config_json: null,
                logo: form.value.logo,
                enabled: form.value.enabled,
                is_builtin: 0,
            });
            return;
        }

        if (!trimmedProviderName.value) {
            alert.error(t('settings.ai.enterProviderName'));
            return;
        }
        emit('update', {
            name: trimmedProviderName.value,
            driver: form.value.driver,
            logo: form.value.logo,
        });
    };
</script>

<template>
    <DialogShell :open="props.open" @closed="emit('closed')">
        <h2 :class="titleClass">{{ title }}</h2>

        <div class="space-y-4">
            <div>
                <label class="block text-sm font-medium text-neutral-700">
                    {{ t('settings.ai.providerNameRequired') }}
                </label>
                <Input
                    v-model="form.name"
                    class="mt-1.5"
                    :placeholder="t('settings.ai.providerNamePlaceholder')"
                />
            </div>

            <div>
                <label class="block text-sm font-medium text-neutral-700">
                    {{ t('settings.ai.providerTypeRequired') }}
                </label>
                <CustomSelect
                    v-model="form.driver"
                    :options="driverOptions"
                    class="mt-1.5"
                    @update:model-value="handleDriverChange"
                />
            </div>

            <div v-if="mode === 'create'">
                <label class="block text-sm font-medium text-neutral-700">
                    {{ t('settings.ai.apiEndpointRequired') }}
                </label>
                <Input
                    v-model="form.api_endpoint"
                    class="mt-1.5"
                    :placeholder="selectedDriverDefinition.placeholder"
                />
                <p
                    v-if="shouldShowGenerationApiPreview"
                    class="mt-1 text-xs break-all text-neutral-400"
                >
                    {{ t('settings.ai.providerBaseUrlPreview') }}
                    <span class="font-mono">
                        {{ generationApiPreview }}
                    </span>
                </p>
            </div>

            <p
                v-else-if="shouldShowGenerationApiPreview"
                class="mt-1 text-xs break-all text-neutral-400"
            >
                {{ t('settings.ai.providerBaseUrlPreview') }}
                <span class="font-mono">
                    {{ generationApiPreview }}
                </span>
            </p>

            <div v-if="mode === 'create'">
                <label class="block text-sm font-medium text-neutral-700">API Key</label>
                <PasswordInput v-model="form.api_key" placeholder="sk-..." />
            </div>

            <div v-if="mode === 'create'" class="flex items-center">
                <input
                    id="enabled"
                    v-model="form.enabled"
                    type="checkbox"
                    :true-value="1"
                    :false-value="0"
                    class="h-4 w-4 rounded border-neutral-300 text-neutral-950"
                />
                <label for="enabled" class="ml-2 text-sm text-neutral-600">
                    {{ t('settings.ai.enableAfterCreate') }}
                </label>
            </div>
        </div>

        <div class="mt-6 flex gap-3">
            <Button
                class="bg-primary-700 hover:bg-primary-600 flex-1 rounded-lg px-4 py-2 text-sm font-medium text-white transition-colors"
                @click="handleSave"
            >
                {{ submitLabel }}
            </Button>
            <Button
                variant="outline"
                class="flex-1 rounded-lg border border-neutral-200 px-4 py-2 text-sm font-medium text-neutral-600 transition-colors hover:border-neutral-300"
                @click="emit('cancel')"
            >
                {{ t('common.cancel') }}
            </Button>
        </div>
    </DialogShell>
</template>

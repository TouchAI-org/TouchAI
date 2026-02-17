<script setup lang="ts">
    import AlertMessage from '@components/common/AlertMessage.vue';
    import SvgIcon from '@components/common/SvgIcon.vue';
    import { getSettingValue, setSetting } from '@database/queries';
    import { native } from '@services/NativeService';
    import { onMounted, onUnmounted, ref, watch } from 'vue';

    interface GeneralSettingsData {
        globalShortcut: string;
        startOnBoot: boolean;
        startMinimized: boolean;
        mcpMaxIterations: number;
    }

    const settings = ref<GeneralSettingsData>({
        globalShortcut: 'Alt+Space',
        startOnBoot: false,
        startMinimized: true,
        mcpMaxIterations: 10,
    });

    const shortcutInput = ref<HTMLInputElement | null>(null);
    const isSaving = ref(false);
    const isCapturing = ref(false);
    const displayShortcut = ref('');
    const alertMessage = ref<InstanceType<typeof AlertMessage> | null>(null);

    // 键名映射表
    const keyNameMap: Record<string, string> = {
        Control: 'Ctrl',
        ' ': 'Space',
        ArrowUp: 'Up',
        ArrowDown: 'Down',
        ArrowLeft: 'Left',
        ArrowRight: 'Right',
        Escape: 'Esc',
        Delete: 'Del',
    };

    // 捕获快捷键
    const captureShortcut = (event: KeyboardEvent) => {
        if (!isCapturing.value) return;

        event.preventDefault();
        event.stopPropagation();

        // 忽略单独的修饰键和 Win 键
        if (['Control', 'Alt', 'Shift', 'Meta', 'OS'].includes(event.key)) {
            return;
        }

        // 不支持 Win 键组合
        if (event.metaKey) {
            alertMessage.value?.warning('不支持 Win 键组合，请使用 Ctrl、Alt、Shift', 3000);
            return;
        }

        const modifiers: string[] = [];
        if (event.ctrlKey) modifiers.push('Ctrl');
        if (event.altKey) modifiers.push('Alt');
        if (event.shiftKey) modifiers.push('Shift');

        // 获取按键名称
        let keyName: string = event.key;

        // 使用映射表转换键名
        const mappedKey = keyNameMap[keyName];
        if (mappedKey) {
            keyName = mappedKey;
        } else if (keyName.length === 1) {
            // 单字符键转为大写
            keyName = keyName.toUpperCase();
        }

        // 组合快捷键字符串
        const shortcut = [...modifiers, keyName].join('+');
        displayShortcut.value = shortcut;
    };

    // 开始捕获（输入框获得焦点）
    const startCapture = () => {
        isCapturing.value = true;
        displayShortcut.value = '请按下快捷键...';
    };

    // 停止捕获并保存（输入框失去焦点）
    const stopCaptureAndSave = async () => {
        if (!isCapturing.value) return;

        isCapturing.value = false;

        // 如果没有捕获到有效快捷键，恢复原值
        if (!displayShortcut.value || displayShortcut.value === '请按下快捷键...') {
            displayShortcut.value = settings.value.globalShortcut;
            return;
        }

        // 如果快捷键没有变化，不需要保存
        if (displayShortcut.value === settings.value.globalShortcut) {
            return;
        }

        // 保存新快捷键
        await saveNewShortcut(displayShortcut.value);
    };

    // 保存新快捷键的通用函数
    const saveNewShortcut = async (newShortcut: string) => {
        isSaving.value = true;

        try {
            // 先注册到 Rust 端
            const registered = await registerShortcut(newShortcut);
            if (!registered) {
                // 注册失败，恢复原值
                displayShortcut.value = settings.value.globalShortcut;
                return;
            }

            // 注册成功后保存到数据库
            await saveShortcutToDatabase(newShortcut);

            // 更新本地状态
            settings.value.globalShortcut = newShortcut;
            displayShortcut.value = newShortcut;
            alertMessage.value?.success('快捷键保存成功', 3000);
        } catch (error) {
            console.error('Failed to save shortcut:', error);
            alertMessage.value?.error('保存快捷键到数据库失败', 3000);
            // 恢复原值
            displayShortcut.value = settings.value.globalShortcut;
        } finally {
            isSaving.value = false;
        }
    };

    // 使用建议的快捷键
    const useSuggestedShortcut = async (shortcut: string) => {
        // 如果正在捕获，先取消捕获
        if (isCapturing.value) {
            isCapturing.value = false;
        }

        // 如果输入框有焦点，先失焦
        if (shortcutInput.value) {
            shortcutInput.value.blur();
        }

        await saveNewShortcut(shortcut);
    };

    // 监听 isCapturing 状态，添加/移除全局键盘监听
    watch(isCapturing, (newValue) => {
        if (newValue) {
            window.addEventListener('keydown', captureShortcut);
        } else {
            window.removeEventListener('keydown', captureShortcut);
        }
    });

    // 从数据库加载设置
    const loadSettings = async () => {
        try {
            const shortcut = await getSettingValue({ key: 'global_shortcut' });
            if (shortcut) {
                settings.value.globalShortcut = shortcut;
                displayShortcut.value = shortcut;
            } else {
                displayShortcut.value = settings.value.globalShortcut;
            }

            const startOnBoot = await getSettingValue({ key: 'start_on_boot' });
            if (startOnBoot) {
                settings.value.startOnBoot = startOnBoot === 'true';
            }

            const startMinimized = await getSettingValue({ key: 'start_minimized' });
            if (startMinimized) {
                settings.value.startMinimized = startMinimized === 'true';
            }

            const mcpMaxIterations = await getSettingValue({ key: 'mcp_max_iterations' });
            if (mcpMaxIterations) {
                settings.value.mcpMaxIterations = parseInt(mcpMaxIterations, 10);
            }
        } catch (error) {
            console.error('Failed to load settings:', error);
            alertMessage.value?.error('加载设置失败', 3000);
        }
    };

    // 注册快捷键到 Rust 端
    const registerShortcut = async (shortcut: string): Promise<boolean> => {
        try {
            await native.shortcut.registerGlobalShortcut(shortcut);
            return true;
        } catch (error) {
            console.error('Failed to register shortcut:', error);

            // 友好的错误提示
            const errorStr = String(error);
            let friendlyMessage = '注册快捷键失败';

            if (errorStr.includes('already registered') || errorStr.includes('已注册')) {
                friendlyMessage = `快捷键 ${shortcut} 已被其他应用占用，请尝试其他组合`;
            } else if (errorStr.includes('invalid') || errorStr.includes('无效')) {
                friendlyMessage = `快捷键 ${shortcut} 格式无效，请重新设置`;
            } else if (errorStr.includes('Unknown key')) {
                friendlyMessage = '不支持的按键，请使用常规按键组合';
            } else {
                friendlyMessage = `注册快捷键失败：${errorStr}`;
            }

            alertMessage.value?.error(friendlyMessage, 4000);
            return false;
        }
    };

    // 保存快捷键到数据库并注册
    const saveShortcutToDatabase = async (shortcut: string) => {
        try {
            await setSetting({ key: 'global_shortcut', value: shortcut });
        } catch (error) {
            console.error('Failed to save shortcut to database:', error);
            throw error;
        }
    };

    const saveStartOnBoot = async () => {
        try {
            await setSetting({
                key: 'start_on_boot',
                value: settings.value.startOnBoot.toString(),
            });

            if (settings.value.startOnBoot) {
                await native.autostart.enableAutostart();
            } else {
                await native.autostart.disableAutostart();
            }
        } catch (error) {
            console.error('Failed to save start_on_boot setting:', error);
            alertMessage.value?.error('保存开机自启动设置失败', 3000);
        }
    };

    const saveStartMinimized = async () => {
        try {
            await setSetting({
                key: 'start_minimized',
                value: settings.value.startMinimized.toString(),
            });
        } catch (error) {
            console.error('Failed to save start_minimized setting:', error);
            alertMessage.value?.error('保存设置失败', 3000);
        }
    };

    const saveMcpMaxIterations = async () => {
        try {
            // 验证范围
            if (settings.value.mcpMaxIterations < 1) {
                settings.value.mcpMaxIterations = 1;
            } else if (settings.value.mcpMaxIterations > 50) {
                settings.value.mcpMaxIterations = 50;
            }

            await setSetting({
                key: 'mcp_max_iterations',
                value: settings.value.mcpMaxIterations.toString(),
            });
            alertMessage.value?.success('保存成功', 2000);
        } catch (error) {
            console.error('Failed to save mcp_max_iterations setting:', error);
            alertMessage.value?.error('保存设置失败', 3000);
        }
    };

    onMounted(async () => {
        await loadSettings();

        // 同步开机自启动状态
        try {
            const isEnabled = await native.autostart.isAutostartEnabled();
            if (isEnabled !== settings.value.startOnBoot) {
                settings.value.startOnBoot = isEnabled;
                await setSetting({ key: 'start_on_boot', value: isEnabled.toString() });
            }
        } catch (error) {
            console.error('Failed to check autostart status:', error);
        }
    });

    // 组件卸载时清理事件监听
    onUnmounted(() => {
        window.removeEventListener('keydown', captureShortcut);
    });
</script>

<template>
    <AlertMessage ref="alertMessage" />

    <div class="p-6">
        <div class="mx-auto max-w-4xl space-y-6">
            <div class="rounded-lg border border-gray-200 bg-white p-6">
                <div class="flex items-center gap-4">
                    <div
                        class="bg-primary-50 text-primary-600 flex h-16 w-16 items-center justify-center rounded-lg"
                    >
                        <SvgIcon name="settings" class="h-6 w-6" />
                    </div>

                    <div class="flex-1">
                        <h2 class="font-serif text-xl font-semibold text-gray-900">常规设置</h2>
                        <p class="mt-1 font-serif text-sm text-gray-600">
                            配置应用的基本行为和外观
                        </p>
                    </div>
                </div>
            </div>

            <div class="space-y-4 rounded-lg border border-gray-200 bg-white p-6">
                <h2 class="font-serif text-lg font-semibold text-gray-900">全局快捷键</h2>
                <div class="space-y-2">
                    <label class="block font-serif text-sm font-medium text-gray-700">
                        唤起快捷键
                    </label>
                    <input
                        ref="shortcutInput"
                        v-model="displayShortcut"
                        type="text"
                        readonly
                        :class="[
                            'w-full rounded-lg border px-4 py-2 font-mono transition-colors focus:ring-2 focus:outline-none',
                            isCapturing
                                ? 'border-primary-600 bg-primary-50 text-primary-600 focus:ring-primary-500'
                                : 'focus:border-primary-600 focus:ring-primary-500 border-gray-200 bg-gray-50 text-gray-900',
                            isSaving ? 'cursor-wait opacity-50' : 'cursor-pointer',
                        ]"
                        :disabled="isSaving"
                        placeholder="点击输入框设置快捷键"
                        @focus="startCapture"
                        @blur="stopCaptureAndSave"
                    />
                    <div class="flex items-center gap-2">
                        <span class="font-serif text-xs text-gray-500">建议：</span>
                        <button
                            class="text-primary-600 hover:text-primary-700 font-mono text-xs underline transition-colors disabled:cursor-not-allowed disabled:opacity-50"
                            :disabled="isSaving"
                            @click="useSuggestedShortcut('Alt+Space')"
                        >
                            Alt+Space
                        </button>
                        <span class="text-gray-300">|</span>
                        <button
                            class="text-primary-600 hover:text-primary-700 font-mono text-xs underline transition-colors disabled:cursor-not-allowed disabled:opacity-50"
                            :disabled="isSaving"
                            @click="useSuggestedShortcut('Ctrl+Space')"
                        >
                            Ctrl+Space
                        </button>
                    </div>
                    <p class="font-serif text-xs text-gray-500">
                        点击输入框后按下您想要设置的快捷键组合。支持的修饰键：Ctrl、Alt、Shift
                    </p>
                </div>
            </div>

            <div class="space-y-4 rounded-lg border border-gray-200 bg-white p-6">
                <h2 class="font-serif text-lg font-semibold text-gray-900">启动设置</h2>
                <div class="space-y-4">
                    <div class="flex items-center justify-between">
                        <div>
                            <div class="font-serif text-sm font-medium text-gray-900">
                                开机自启动
                            </div>
                            <div class="font-serif text-xs text-gray-500">
                                系统启动时自动运行TouchAI
                            </div>
                        </div>
                        <button
                            :class="[
                                'relative inline-flex h-6 w-11 items-center rounded-full transition-colors',
                                settings.startOnBoot ? 'bg-primary-600' : 'bg-gray-200',
                            ]"
                            @click="
                                settings.startOnBoot = !settings.startOnBoot;
                                saveStartOnBoot();
                            "
                        >
                            <span
                                :class="[
                                    'inline-block h-4 w-4 transform rounded-full bg-white transition-transform',
                                    settings.startOnBoot ? 'translate-x-6' : 'translate-x-1',
                                ]"
                            />
                        </button>
                    </div>

                    <div class="flex items-center justify-between">
                        <div>
                            <div class="font-serif text-sm font-medium text-gray-900">
                                启动时最小化
                            </div>
                            <div class="font-serif text-xs text-gray-500">启动后隐藏到系统托盘</div>
                        </div>
                        <button
                            :class="[
                                'relative inline-flex h-6 w-11 items-center rounded-full transition-colors',
                                settings.startMinimized ? 'bg-primary-600' : 'bg-gray-200',
                            ]"
                            @click="
                                settings.startMinimized = !settings.startMinimized;
                                saveStartMinimized();
                            "
                        >
                            <span
                                :class="[
                                    'inline-block h-4 w-4 transform rounded-full bg-white transition-transform',
                                    settings.startMinimized ? 'translate-x-6' : 'translate-x-1',
                                ]"
                            />
                        </button>
                    </div>
                </div>
            </div>

            <div class="space-y-4 rounded-lg border border-gray-200 bg-white p-6">
                <h2 class="font-serif text-lg font-semibold text-gray-900">AI 工具调用</h2>
                <div class="space-y-4">
                    <div class="flex items-center justify-between">
                        <div class="flex-1">
                            <div class="font-serif text-sm font-medium text-gray-900">
                                最大工具调用轮数
                            </div>
                            <div class="font-serif text-xs text-gray-500">
                                AI 可以连续调用工具的最大次数（1-50）
                            </div>
                        </div>
                        <div class="flex items-center gap-2">
                            <input
                                v-model.number="settings.mcpMaxIterations"
                                type="number"
                                min="1"
                                max="50"
                                class="focus:border-primary-600 focus:ring-primary-500 w-20 rounded-lg border border-gray-200 px-3 py-1 text-center font-mono text-sm focus:ring-2 focus:outline-none"
                                @blur="saveMcpMaxIterations"
                            />
                        </div>
                    </div>
                </div>
            </div>
        </div>
    </div>
</template>

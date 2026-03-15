<!-- Copyright (c) 2026. 千诚. Licensed under GPL v3 -->

<script setup lang="ts">
    import CustomSelect from '@components/CustomSelect.vue';
    import { createMcpServer, updateMcpServer } from '@database/queries';
    import type { DbTransportType, McpServerCreateData, McpServerEntity } from '@database/types';
    import { computed, onUnmounted, ref, watch } from 'vue';

    import { useMcpStore } from '@/stores/mcp';

    import McpHttpFields from './McpHttpFields.vue';
    import McpServerHeader from './McpServerHeader.vue';
    import McpStdioFields from './McpStdioFields.vue';

    interface Props {
        server: McpServerEntity;
    }

    interface Emits {
        (e: 'updated', wasNewServer: boolean): void;
        (e: 'deleted'): void;
        (e: 'showAlert', message: string, type: 'success' | 'error'): void;
        (e: 'cancelled'): void;
    }

    const props = defineProps<Props>();
    const emit = defineEmits<Emits>();

    const isNewServer = computed(() => props.server.id === -1);
    const mcpStore = useMcpStore();

    const isSaving = ref(false);

    // 检查必填字段是否已填写
    const isRequiredFieldsFilled = computed(() => {
        if (!editableConfig.value.name.trim()) return false;

        if (editableConfig.value.transportType === 'stdio') {
            return !!editableConfig.value.command.trim();
        } else {
            return !!editableConfig.value.url.trim();
        }
    });

    // 编辑状态的配置数据
    const editableConfig = ref({
        name: props.server.name,
        transportType: props.server.transport_type as DbTransportType,
        command: props.server.command || '',
        args: [] as string[],
        env: [] as { key: string; value: string }[],
        cwd: props.server.cwd || '',
        url: props.server.url || '',
        headers: [] as { key: string; value: string }[],
        toolTimeout: props.server.tool_timeout,
    });

    const transportOptions = [
        { label: 'Stdio', value: 'stdio' as DbTransportType, description: '标准输入输出' },
        {
            label: 'SSE(Streamable HTTP)',
            value: 'sse' as DbTransportType,
            description: '兼容Streamable HTTP与SSE',
        },
        { label: 'HTTP', value: 'http' as DbTransportType, description: 'HTTP POST' },
    ];

    // 初始化参数数组
    try {
        const parsedArgs = props.server.args ? JSON.parse(props.server.args) : [];
        editableConfig.value.args = Array.isArray(parsedArgs) ? parsedArgs : [];
    } catch {
        editableConfig.value.args = [];
    }

    // 初始化环境变量数组
    try {
        const parsedEnv = props.server.env ? JSON.parse(props.server.env) : {};
        editableConfig.value.env = Object.entries(parsedEnv).map(([key, value]) => ({
            key,
            value: String(value),
        }));
    } catch {
        editableConfig.value.env = [];
    }

    // 初始化请求头数组
    try {
        const parsedHeaders = props.server.headers ? JSON.parse(props.server.headers) : {};
        editableConfig.value.headers = Object.entries(parsedHeaders).map(([key, value]) => ({
            key,
            value: String(value),
        }));
    } catch {
        editableConfig.value.headers = [];
    }

    // 监听 props 变化更新编辑数据
    watch(
        () => props.server,
        (newServer) => {
            editableConfig.value.name = newServer.name;
            editableConfig.value.transportType = newServer.transport_type as DbTransportType;
            editableConfig.value.command = newServer.command || '';
            editableConfig.value.cwd = newServer.cwd || '';
            editableConfig.value.url = newServer.url || '';
            editableConfig.value.toolTimeout = newServer.tool_timeout;

            // 解析参数
            try {
                const parsedArgs = newServer.args ? JSON.parse(newServer.args) : [];
                editableConfig.value.args = Array.isArray(parsedArgs) ? parsedArgs : [];
            } catch {
                editableConfig.value.args = [];
            }

            // 解析环境变量
            try {
                const parsedEnv = newServer.env ? JSON.parse(newServer.env) : {};
                editableConfig.value.env = Object.entries(parsedEnv).map(([key, value]) => ({
                    key,
                    value: String(value),
                }));
            } catch {
                editableConfig.value.env = [];
            }

            // 解析请求头
            try {
                const parsedHeaders = newServer.headers ? JSON.parse(newServer.headers) : {};
                editableConfig.value.headers = Object.entries(parsedHeaders).map(
                    ([key, value]) => ({
                        key,
                        value: String(value),
                    })
                );
            } catch {
                editableConfig.value.headers = [];
            }
        },
        { deep: true }
    );

    // 监听必填字段变化，自动保存新服务器
    let autoSaveTimer: ReturnType<typeof setTimeout> | null = null;
    onUnmounted(() => {
        if (autoSaveTimer) clearTimeout(autoSaveTimer);
    });
    watch(
        [
            () => editableConfig.value.name,
            () => editableConfig.value.transportType,
            () => editableConfig.value.command,
            () => editableConfig.value.url,
        ],
        () => {
            // 只对新服务器自动保存
            if (!isNewServer.value) return;

            // 清除之前的定时器
            if (autoSaveTimer) {
                clearTimeout(autoSaveTimer);
            }

            // 检查必填字段是否已填写
            if (isRequiredFieldsFilled.value) {
                // 延迟 800ms 自动保存，避免用户还在输入时就保存
                autoSaveTimer = setTimeout(() => {
                    handleSave();
                }, 800);
            }
        }
    );

    const onBlur = () => {
        if (!isNewServer.value) {
            handleSave();
        }
    };

    const handleSave = async () => {
        if (isSaving.value) return;

        // 验证必填字段
        if (!editableConfig.value.name.trim()) {
            emit('showAlert', '请输入服务器名称', 'error');
            return;
        }

        if (editableConfig.value.transportType === 'stdio') {
            if (!editableConfig.value.command.trim()) {
                emit('showAlert', '请输入命令', 'error');
                return;
            }
        } else {
            if (!editableConfig.value.url.trim()) {
                emit('showAlert', '请输入 URL', 'error');
                return;
            }
        }

        const wasNewServer = isNewServer.value;
        isSaving.value = true;
        try {
            // 将参数数组转换为 JSON 字符串
            const argsJson = JSON.stringify(editableConfig.value.args.filter((arg) => arg.trim()));

            // 将环境变量数组转换为 JSON 对象字符串
            const envObj = editableConfig.value.env
                .filter((env) => env.key.trim())
                .reduce(
                    (acc, env) => {
                        acc[env.key] = env.value;
                        return acc;
                    },
                    {} as Record<string, string>
                );
            const envJson = JSON.stringify(envObj);

            // 将请求头数组转换为 JSON 对象字符串
            const headersObj = editableConfig.value.headers
                .filter((header) => header.key.trim())
                .reduce(
                    (acc, header) => {
                        acc[header.key] = header.value;
                        return acc;
                    },
                    {} as Record<string, string>
                );
            const headersJson = JSON.stringify(headersObj);

            const serverData: McpServerCreateData = {
                name: editableConfig.value.name.trim(),
                transport_type: editableConfig.value.transportType,
                command: editableConfig.value.command.trim() || null,
                args: argsJson || null,
                env: envJson || null,
                cwd: editableConfig.value.cwd.trim() || null,
                url: editableConfig.value.url.trim() || null,
                headers: headersJson || null,
                tool_timeout: editableConfig.value.toolTimeout,
            };

            if (wasNewServer) {
                // 创建新服务器 - 不包含 id 字段
                await createMcpServer(serverData);
                emit('showAlert', '服务器创建成功', 'success');
            } else {
                // 更新现有服务器
                await updateMcpServer(props.server.id, serverData);
            }

            await mcpStore.loadServers();
            emit('updated', wasNewServer);
        } catch (error) {
            console.error('Failed to save server config:', error);
            emit('showAlert', '保存配置失败', 'error');
        } finally {
            isSaving.value = false;
        }
    };
</script>

<template>
    <div class="space-y-4 p-6">
        <!-- 服务器头部 -->
        <McpServerHeader
            :server="server"
            :is-new-server="isNewServer"
            @show-alert="(message, type) => emit('showAlert', message, type)"
        />

        <!-- 配置详情 -->
        <div class="space-y-4">
            <div class="flex items-center justify-between">
                <h3 class="font-serif text-sm font-semibold text-gray-900">服务器配置</h3>
            </div>

            <div class="rounded-lg border border-gray-200 bg-white p-5">
                <div class="space-y-4">
                    <!-- 名称 -->
                    <div>
                        <label class="block font-serif text-sm font-medium text-gray-600">
                            名称
                            <span class="text-red-500">*</span>
                        </label>
                        <input
                            v-model="editableConfig.name"
                            type="text"
                            class="focus:border-primary-400 mt-1.5 w-full rounded-lg border border-gray-200 px-3 py-2 font-serif text-sm text-gray-900 transition-colors focus:outline-none"
                            placeholder="服务器名称"
                            @blur="onBlur"
                        />
                    </div>

                    <!-- 传输类型 -->
                    <div>
                        <label class="block font-serif text-sm font-medium text-gray-600">
                            传输类型
                            <span class="text-red-500">*</span>
                        </label>
                        <CustomSelect
                            v-model="editableConfig.transportType"
                            :options="transportOptions"
                            class="mt-1.5"
                            @update:model-value="onBlur"
                        />
                    </div>

                    <!-- Stdio 配置 -->
                    <McpStdioFields
                        v-if="editableConfig.transportType === 'stdio'"
                        v-model:command="editableConfig.command"
                        v-model:args="editableConfig.args"
                        v-model:cwd="editableConfig.cwd"
                        v-model:env="editableConfig.env"
                        @blur="onBlur"
                    />

                    <!-- HTTP/SSE 配置 -->
                    <McpHttpFields
                        v-else
                        v-model:url="editableConfig.url"
                        v-model:headers="editableConfig.headers"
                        @blur="onBlur"
                    />

                    <!-- 工具超时 -->
                    <div>
                        <label class="block font-serif text-sm font-medium text-gray-600">
                            工具超时 (毫秒)
                        </label>
                        <input
                            v-model.number="editableConfig.toolTimeout"
                            type="number"
                            class="focus:border-primary-400 mt-1.5 w-full rounded-lg border border-gray-200 px-3 py-2 font-serif text-sm text-gray-900 transition-colors focus:outline-none"
                            placeholder="30000"
                            @blur="onBlur"
                        />
                    </div>
                </div>
            </div>
        </div>
    </div>
</template>

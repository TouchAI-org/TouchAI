<script setup lang="ts">
    import AppIcon from '@components/AppIcon.vue';
    import { appUpdateService } from '@services/AppUpdateService';
    import type { AppUpdateChannel, AppUpdateState } from '@services/AppUpdateService/types';
    import { getTauriVersion, getVersion } from '@tauri-apps/api/app';
    import { openUrl } from '@tauri-apps/plugin-opener';
    import { computed, onMounted, onUnmounted, ref } from 'vue';

    import { APP_UPDATE_CHANNELS, appUpdateChannelLabel } from '@/config/appUpdate';
    import { APP_PRODUCT_CONFIG } from '@/config/product';
    import { preferredAppUpdateDownload } from '@/services/AppUpdateService/downloads';

    defineOptions({
        name: 'SettingsAboutSection',
    });

    interface SystemInfo {
        os: string;
        osVersion: string;
        arch: string;
        tauriVersion: string;
    }

    const appVersion = ref('0.1.0');
    const updateState = ref<AppUpdateState>(appUpdateService.getState());
    const systemInfo = ref<SystemInfo>({
        os: 'Unknown',
        osVersion: 'Unknown',
        arch: 'Unknown',
        tauriVersion: '2.x',
    });
    let unsubscribeUpdateState: (() => void) | null = null;

    const updateChannelOptions: { value: AppUpdateChannel; label: string }[] =
        APP_UPDATE_CHANNELS.map((value) => ({
            value,
            label: appUpdateChannelLabel(value),
        }));
    const appDisplayName = APP_PRODUCT_CONFIG.displayName;
    const links = APP_PRODUCT_CONFIG.repository;

    const visibleUpdate = computed(
        () => updateState.value.downloadedUpdate ?? updateState.value.availableUpdate
    );
    const latestUpdate = computed(() => updateState.value.latestUpdate);
    const updateRequirement = computed(() => updateState.value.updateRequirement);
    const directDownload = computed(() =>
        preferredAppUpdateDownload(latestUpdate.value?.downloads ?? [])
    );
    const directDownloadUrl = computed(() => directDownload.value?.url ?? null);
    const updateDownloadUrl = computed(
        () => directDownloadUrl.value ?? latestUpdate.value?.releaseUrl ?? links.releasesUrl
    );
    const currentChannelLabel = computed(
        () =>
            updateChannelOptions.find((option) => option.value === updateState.value.channel)
                ?.label ?? 'Stable'
    );
    const targetUpdateVersion = computed(
        () =>
            visibleUpdate.value?.version ??
            latestUpdate.value?.version ??
            updateRequirement.value?.minimumSupportedVersion ??
            ''
    );
    const updateSummaryText = computed(() => {
        if (latestUpdate.value?.version) {
            return `最新版本 ${latestUpdate.value.version} · ${currentChannelLabel.value}`;
        }

        if (updateRequirement.value?.minimumSupportedVersion) {
            return `最低支持版本 ${updateRequirement.value.minimumSupportedVersion} · ${currentChannelLabel.value}`;
        }

        return `GitHub Releases · ${currentChannelLabel.value}`;
    });
    const isChecking = computed(() => updateState.value.status === 'checking');
    const isDownloading = computed(() => updateState.value.status === 'downloading');
    const isInstalling = computed(() => updateState.value.status === 'installing');
    const isBusy = computed(() => isChecking.value || isDownloading.value || isInstalling.value);
    const isRequiredUpdate = computed(() => updateRequirement.value?.required ?? false);
    const requiredUpdateText = computed(() => {
        const requirement = updateRequirement.value;
        if (!requirement?.required) {
            return '';
        }

        const parts: string[] = [];
        if (requirement.requiredReason) {
            parts.push(requirement.requiredReason);
        }
        if (requirement.minimumSupportedVersion) {
            parts.push(`最低支持版本 ${requirement.minimumSupportedVersion}`);
        }
        if (targetUpdateVersion.value) {
            parts.push(`可更新到 ${targetUpdateVersion.value}`);
        }
        if (!requirement.targetSatisfiesRequirement) {
            parts.push('当前通道暂未提供满足要求的更新');
        }

        return parts.join(' · ') || '当前版本已不再受支持';
    });

    const updateStatusText = computed(() => {
        switch (updateState.value.status) {
            case 'checking':
                return '正在检查更新...';
            case 'available':
                if (isRequiredUpdate.value) {
                    return targetUpdateVersion.value
                        ? `请更新到 ${targetUpdateVersion.value} 以继续使用`
                        : '当前版本已不再受支持';
                }
                return visibleUpdate.value
                    ? `发现新版本 ${visibleUpdate.value.version}`
                    : '发现新版本';
            case 'not_available':
                if (isRequiredUpdate.value) {
                    const minimumVersion = updateRequirement.value?.minimumSupportedVersion;
                    return minimumVersion
                        ? `请更新到 ${minimumVersion} 或更高版本`
                        : '当前版本已不再受支持';
                }
                return '当前已是最新版本';
            case 'downloading':
                return `正在下载更新 ${updateState.value.downloadProgress ?? 0}%`;
            case 'downloaded':
                return visibleUpdate.value
                    ? `版本 ${visibleUpdate.value.version} 已下载`
                    : '更新已下载';
            case 'installing':
                return '正在安装并重启...';
            case 'failed':
                return updateState.value.error ?? '更新检查失败';
            case 'unsupported':
                return '当前运行方式暂不支持应用内更新';
            case 'idle':
            default:
                return '可检查 GitHub Releases 上的新版本';
        }
    });

    const updateHintText = computed(() => {
        if (updateState.value.status === 'unsupported') {
            return `通过正式安装包安装 ${appDisplayName} 后即可使用自动更新。`;
        }

        if (updateState.value.status === 'failed') {
            return '请稍后重试，或到 GitHub Releases 手动下载安装包。';
        }

        if (visibleUpdate.value?.notes) {
            return visibleUpdate.value.notes;
        }

        if (latestUpdate.value?.releaseNotes) {
            return latestUpdate.value.releaseNotes;
        }

        if (latestUpdate.value?.version) {
            return `当前通道最新版本：${latestUpdate.value.version}`;
        }

        if (updateState.value.lastCheckedAt) {
            return `上次检查：${new Date(updateState.value.lastCheckedAt).toLocaleString()}`;
        }

        return '自动检查默认每天最多运行一次，下载和安装前会等待确认。';
    });

    const updateSizeText = computed(() => {
        const sizeBytes = visibleUpdate.value?.sizeBytes;
        if (!sizeBytes || sizeBytes <= 0) {
            return '';
        }

        return `${(sizeBytes / 1024 / 1024).toFixed(1)} MB`;
    });

    const getOsInfo = (): { os: string; arch: string } => {
        const userAgent = navigator.userAgent.toLowerCase();
        const platform = navigator.platform.toLowerCase();

        let os = 'Unknown';
        let arch = 'Unknown';

        // Detect OS
        if (userAgent.includes('win')) {
            os = 'Windows';
        } else if (userAgent.includes('mac')) {
            os = 'macOS';
        } else if (userAgent.includes('linux')) {
            os = 'Linux';
        }

        // Detect architecture
        if (
            platform.includes('win64') ||
            platform.includes('x86_64') ||
            platform.includes('amd64')
        ) {
            arch = 'x86_64';
        } else if (platform.includes('win32') || platform.includes('x86')) {
            arch = 'x86';
        } else if (platform.includes('arm64') || userAgent.includes('arm64')) {
            arch = 'aarch64';
        } else if (platform.includes('arm')) {
            arch = 'arm';
        }

        return { os, arch };
    };

    const getOsVersion = (): string => {
        const userAgent = navigator.userAgent;

        // Windows version
        const winMatch = userAgent.match(/Windows NT (\d+\.\d+)/);
        if (winMatch && winMatch[1]) {
            const version = winMatch[1];
            const versionMap: Record<string, string> = {
                '10.0': 'Windows 10/11',
                '6.3': 'Windows 8.1',
                '6.2': 'Windows 8',
                '6.1': 'Windows 7',
            };
            return versionMap[version] || `Windows NT ${version}`;
        }

        // macOS version
        const macMatch = userAgent.match(/Mac OS X (\d+[._]\d+[._]\d+)/);
        if (macMatch && macMatch[1]) {
            return macMatch[1].replace(/_/g, '.');
        }

        // Linux - harder to detect specific version
        if (userAgent.includes('Linux')) {
            return 'Linux';
        }

        return 'Unknown';
    };

    onMounted(async () => {
        unsubscribeUpdateState = appUpdateService.subscribe((state) => {
            updateState.value = state;
        });

        try {
            // Get app version and Tauri version
            const [appVer, tauriVer] = await Promise.all([getVersion(), getTauriVersion()]);

            appVersion.value = appVer;

            // Get OS info from browser APIs
            const { os, arch } = getOsInfo();
            const osVersion = getOsVersion();

            systemInfo.value = {
                os,
                osVersion,
                arch,
                tauriVersion: tauriVer,
            };
        } catch (error) {
            console.error('Failed to get system info:', error);
        }

        try {
            await appUpdateService.initialize();
        } catch (error) {
            console.error('Failed to initialize update service:', error);
        }
    });

    onUnmounted(() => {
        unsubscribeUpdateState?.();
        unsubscribeUpdateState = null;
    });

    const checkForUpdates = async () => {
        await appUpdateService.checkNow('manual');
    };

    const downloadUpdate = async () => {
        await appUpdateService.download();
    };

    const installUpdate = async () => {
        await appUpdateService.install();
    };

    const openUpdateDownloadPage = async () => {
        await openLink(updateDownloadUrl.value);
    };

    const toggleAutoCheck = async () => {
        await appUpdateService.setAutoCheckEnabled(!updateState.value.autoCheckEnabled);
    };

    const selectUpdateChannel = async (channel: AppUpdateChannel) => {
        if (channel === updateState.value.channel || isBusy.value) {
            return;
        }

        await appUpdateService.setChannel(channel);
    };

    const openLink = async (url: string) => {
        try {
            await openUrl(url);
        } catch (error) {
            console.error('Failed to open link:', error);
        }
    };
</script>

<template>
    <div class="p-6">
        <div class="mx-auto max-w-4xl space-y-6">
            <div class="rounded-lg border border-gray-200 bg-white p-6">
                <div class="flex items-center gap-4">
                    <div
                        class="bg-primary-50 text-primary-600 flex h-16 w-16 items-center justify-center rounded-lg"
                    >
                        <AppIcon name="information-circle" class="h-6 w-6" />
                    </div>

                    <div class="flex-1">
                        <h2 class="font-serif text-xl font-semibold text-gray-900">
                            关于 {{ appDisplayName }}
                        </h2>
                        <p class="mt-1 font-serif text-sm text-gray-600">全局AI助手</p>
                    </div>
                </div>
            </div>

            <div class="space-y-4 rounded-lg border border-gray-200 bg-white p-6">
                <h2 class="mb-4 font-serif text-lg font-semibold text-gray-900">应用信息</h2>
                <div class="grid grid-cols-2 gap-4">
                    <div>
                        <div class="font-serif text-sm text-gray-500">应用名称</div>
                        <div class="font-serif text-base text-gray-900">
                            {{ appDisplayName }}
                        </div>
                    </div>
                    <div>
                        <div class="font-serif text-sm text-gray-500">版本</div>
                        <div class="font-serif text-base text-gray-900">{{ appVersion }}</div>
                    </div>
                    <div>
                        <div class="font-serif text-sm text-gray-500">开发者</div>
                        <div class="font-serif text-base text-gray-900">千诚</div>
                    </div>
                    <div>
                        <div class="font-serif text-sm text-gray-500">许可证</div>
                        <div class="font-serif text-base text-gray-900">GPL v3</div>
                    </div>
                </div>
            </div>

            <div class="space-y-4 rounded-lg border border-gray-200 bg-white p-6">
                <div class="flex items-start justify-between gap-4">
                    <div>
                        <h2 class="font-serif text-lg font-semibold text-gray-900">应用更新</h2>
                        <p class="mt-1 font-serif text-sm text-gray-600">
                            {{ updateStatusText }}
                        </p>
                    </div>
                    <button
                        :class="[
                            'relative inline-flex h-6 w-11 shrink-0 items-center rounded-full transition-colors',
                            updateState.autoCheckEnabled ? 'bg-primary-600' : 'bg-gray-200',
                        ]"
                        data-testid="settings-update-auto-check"
                        :aria-pressed="updateState.autoCheckEnabled"
                        title="自动检查更新"
                        @click="toggleAutoCheck"
                    >
                        <span
                            :class="[
                                'inline-block h-4 w-4 transform rounded-full bg-white transition-transform',
                                updateState.autoCheckEnabled ? 'translate-x-6' : 'translate-x-1',
                            ]"
                        />
                    </button>
                </div>

                <div
                    v-if="isDownloading"
                    class="h-2 overflow-hidden rounded-full bg-gray-100"
                    aria-label="下载进度"
                >
                    <div
                        class="bg-primary-600 h-full rounded-full transition-all"
                        :style="{ width: `${updateState.downloadProgress ?? 0}%` }"
                    />
                </div>

                <div
                    class="flex flex-wrap items-center justify-between gap-3 rounded-lg bg-gray-50 px-4 py-3"
                >
                    <div class="min-w-0">
                        <div class="font-serif text-sm font-medium text-gray-900">
                            {{ updateSummaryText }}
                        </div>
                        <div class="mt-1 line-clamp-2 font-serif text-xs text-gray-500">
                            {{ updateHintText }}
                        </div>
                        <div
                            v-if="requiredUpdateText"
                            class="mt-1 font-serif text-xs font-medium text-red-600"
                        >
                            {{ requiredUpdateText }}
                        </div>
                        <div v-if="updateSizeText" class="mt-1 font-serif text-xs text-gray-400">
                            {{ updateSizeText }}
                        </div>
                    </div>

                    <div class="flex shrink-0 items-center gap-2">
                        <div
                            class="flex h-9 items-center rounded-lg border border-gray-200 bg-white p-1"
                            aria-label="更新通道"
                        >
                            <button
                                v-for="option in updateChannelOptions"
                                :key="option.value"
                                :class="[
                                    'rounded-md px-2 py-1 font-serif text-xs transition-colors disabled:cursor-not-allowed disabled:opacity-50',
                                    updateState.channel === option.value
                                        ? 'bg-primary-600 text-white'
                                        : 'text-gray-600 hover:bg-gray-100',
                                ]"
                                :data-testid="`settings-update-channel-${option.value}`"
                                :disabled="isBusy"
                                @click="selectUpdateChannel(option.value)"
                            >
                                {{ option.label }}
                            </button>
                        </div>
                        <button
                            class="hover:border-primary-300 hover:text-primary-700 flex items-center gap-1 rounded-lg border border-gray-200 bg-white px-3 py-2 font-serif text-xs text-gray-700 transition-colors disabled:cursor-not-allowed disabled:opacity-50"
                            :disabled="isBusy"
                            @click="checkForUpdates"
                        >
                            <AppIcon name="refresh" class="h-4 w-4" />
                            检查
                        </button>
                        <button
                            v-if="
                                updateState.status === 'available' &&
                                (!isRequiredUpdate || updateRequirement?.targetSatisfiesRequirement)
                            "
                            class="bg-primary-600 hover:bg-primary-700 flex items-center gap-1 rounded-lg px-3 py-2 font-serif text-xs text-white transition-colors disabled:cursor-not-allowed disabled:opacity-50"
                            data-testid="settings-update-download"
                            :disabled="isBusy"
                            @click="downloadUpdate"
                        >
                            <AppIcon name="arrow-down" class="h-4 w-4" />
                            下载
                        </button>
                        <button
                            v-if="
                                isRequiredUpdate &&
                                (!visibleUpdate || !updateRequirement?.targetSatisfiesRequirement)
                            "
                            class="hover:border-primary-300 hover:text-primary-700 flex items-center gap-1 rounded-lg border border-gray-200 bg-white px-3 py-2 font-serif text-xs text-gray-700 transition-colors disabled:cursor-not-allowed disabled:opacity-50"
                            :disabled="isBusy"
                            @click="openUpdateDownloadPage"
                        >
                            <AppIcon name="arrow-down" class="h-4 w-4" />
                            {{ directDownloadUrl ? '安装包' : '下载页' }}
                        </button>
                        <button
                            v-if="updateState.status === 'downloaded'"
                            class="bg-primary-600 hover:bg-primary-700 flex items-center gap-1 rounded-lg px-3 py-2 font-serif text-xs text-white transition-colors disabled:cursor-not-allowed disabled:opacity-50"
                            :disabled="isBusy"
                            @click="installUpdate"
                        >
                            <AppIcon name="check-circle" class="h-4 w-4" />
                            安装并重启
                        </button>
                    </div>
                </div>
            </div>

            <div class="space-y-4 rounded-lg border border-gray-200 bg-white p-6">
                <h2 class="mb-4 font-serif text-lg font-semibold text-gray-900">系统信息</h2>
                <div class="grid grid-cols-2 gap-4">
                    <div>
                        <div class="font-serif text-sm text-gray-500">操作系统</div>
                        <div class="font-serif text-base text-gray-900">{{ systemInfo.os }}</div>
                    </div>
                    <div>
                        <div class="font-serif text-sm text-gray-500">系统版本</div>
                        <div class="font-serif text-base text-gray-900">
                            {{ systemInfo.osVersion }}
                        </div>
                    </div>
                    <div>
                        <div class="font-serif text-sm text-gray-500">架构</div>
                        <div class="font-serif text-base text-gray-900">{{ systemInfo.arch }}</div>
                    </div>
                    <div>
                        <div class="font-serif text-sm text-gray-500">Tauri版本</div>
                        <div class="font-serif text-base text-gray-900">
                            {{ systemInfo.tauriVersion }}
                        </div>
                    </div>
                </div>
            </div>

            <div class="space-y-4 rounded-lg border border-gray-200 bg-white p-6">
                <h2 class="mb-4 font-serif text-lg font-semibold text-gray-900">外部链接</h2>
                <div class="space-y-3">
                    <button
                        class="flex w-full items-center justify-between rounded-lg bg-gray-50 px-4 py-3 text-left transition-colors hover:bg-gray-100"
                        @click="openLink(links.url)"
                    >
                        <span class="font-serif text-gray-900">GitHub仓库</span>
                        <svg
                            class="h-5 w-5 text-gray-400"
                            fill="none"
                            stroke="currentColor"
                            viewBox="0 0 24 24"
                        >
                            <path
                                stroke-linecap="round"
                                stroke-linejoin="round"
                                stroke-width="2"
                                d="M10 6H6a2 2 0 00-2 2v10a2 2 0 002 2h10a2 2 0 002-2v-4M14 4h6m0 0v6m0-6L10 14"
                            />
                        </svg>
                    </button>
                    <button
                        class="flex w-full items-center justify-between rounded-lg bg-gray-50 px-4 py-3 text-left transition-colors hover:bg-gray-100"
                        @click="openLink(links.docsUrl)"
                    >
                        <span class="font-serif text-gray-900">文档</span>
                        <svg
                            class="h-5 w-5 text-gray-400"
                            fill="none"
                            stroke="currentColor"
                            viewBox="0 0 24 24"
                        >
                            <path
                                stroke-linecap="round"
                                stroke-linejoin="round"
                                stroke-width="2"
                                d="M10 6H6a2 2 0 00-2 2v10a2 2 0 002 2h10a2 2 0 002-2v-4M14 4h6m0 0v6m0-6L10 14"
                            />
                        </svg>
                    </button>
                    <button
                        class="flex w-full items-center justify-between rounded-lg bg-gray-50 px-4 py-3 text-left transition-colors hover:bg-gray-100"
                        @click="openLink(links.issuesUrl)"
                    >
                        <span class="font-serif text-gray-900">问题反馈</span>
                        <svg
                            class="h-5 w-5 text-gray-400"
                            fill="none"
                            stroke="currentColor"
                            viewBox="0 0 24 24"
                        >
                            <path
                                stroke-linecap="round"
                                stroke-linejoin="round"
                                stroke-width="2"
                                d="M10 6H6a2 2 0 00-2 2v10a2 2 0 002 2h10a2 2 0 002-2v-4M14 4h6m0 0v6m0-6L10 14"
                            />
                        </svg>
                    </button>
                </div>
            </div>
        </div>
    </div>
</template>

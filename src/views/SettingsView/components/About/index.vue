<script setup lang="ts">
    import SvgIcon from '@components/SvgIcon.vue';
    import { getTauriVersion, getVersion } from '@tauri-apps/api/app';
    import { openUrl } from '@tauri-apps/plugin-opener';
    import { onMounted, ref } from 'vue';

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
    const systemInfo = ref<SystemInfo>({
        os: 'Unknown',
        osVersion: 'Unknown',
        arch: 'Unknown',
        tauriVersion: '2.x',
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
    });

    const openLink = async (url: string) => {
        try {
            await openUrl(url);
        } catch (error) {
            console.error('Failed to open link:', error);
        }
    };

    const links = {
        github: 'https://github.com/xlgzsgf/touchai',
        docs: 'https://github.com/xlgzsgf/touchai/wiki',
        issues: 'https://github.com/xlgzsgf/touchai/issues',
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
                        <SvgIcon name="information-circle" class="h-6 w-6" />
                    </div>

                    <div class="flex-1">
                        <h2 class="font-serif text-xl font-semibold text-gray-900">关于 TouchAI</h2>
                        <p class="mt-1 font-serif text-sm text-gray-600">全局AI助手</p>
                    </div>
                </div>
            </div>

            <div class="space-y-4 rounded-lg border border-gray-200 bg-white p-6">
                <h2 class="mb-4 font-serif text-lg font-semibold text-gray-900">应用信息</h2>
                <div class="grid grid-cols-2 gap-4">
                    <div>
                        <div class="font-serif text-sm text-gray-500">应用名称</div>
                        <div class="font-serif text-base text-gray-900">TouchAI</div>
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
                        @click="openLink(links.github)"
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
                        @click="openLink(links.docs)"
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
                        @click="openLink(links.issues)"
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

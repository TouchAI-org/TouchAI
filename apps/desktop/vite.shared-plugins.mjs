import tailwindcss from '@tailwindcss/vite';
import vue from '@vitejs/plugin-vue';
import Icons from 'unplugin-icons/vite';

export function createDesktopVitePlugins(desktopRoot) {
    if (!desktopRoot) throw new Error('desktopRoot is required');
    return [
        Icons({
            compiler: 'vue3',
            collectionsNodeResolvePath: desktopRoot,
        }),
        tailwindcss(),
        vue(),
    ];
}

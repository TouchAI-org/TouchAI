import { configDefaults, defineConfig } from 'vitest/config';

const nativeMemoryTests = ['tests/ci/workflows/lifecycle-native-memory.test.ts'];

export default defineConfig({
    test: {
        projects: [
            {
                test: {
                    name: 'repository',
                    environment: 'node',
                    include: ['tests/ci/**/*.test.ts'],
                    exclude: [...configDefaults.exclude, ...nativeMemoryTests],
                    sequence: { groupOrder: 0 },
                },
            },
            {
                test: {
                    name: 'native-memory',
                    environment: 'node',
                    include: nativeMemoryTests,
                    sequence: { groupOrder: 1 },
                },
            },
        ],
    },
});

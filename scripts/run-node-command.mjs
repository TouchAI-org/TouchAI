import { spawnSync } from 'node:child_process';

const DEFAULT_MEMORY_FLAG = '--max-old-space-size=8192';

function resolveNodeOptions() {
    const existingNodeOptions = process.env.NODE_OPTIONS?.trim() ?? '';

    if (existingNodeOptions.includes('--max-old-space-size=')) {
        return existingNodeOptions;
    }

    return [DEFAULT_MEMORY_FLAG, existingNodeOptions].filter(Boolean).join(' ');
}

function main() {
    const [command, ...args] = process.argv.slice(2);

    if (!command) {
        console.error('Usage: node scripts/run-node-command.mjs <command> [...args]');
        process.exit(1);
    }

    const result = spawnSync(command, args, {
        env: {
            ...process.env,
            NODE_OPTIONS: resolveNodeOptions(),
        },
        shell: true,
        stdio: 'inherit',
    });

    if (typeof result.status === 'number') {
        process.exit(result.status);
    }

    process.exit(1);
}

main();

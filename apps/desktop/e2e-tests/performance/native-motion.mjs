export async function enableNativeNormalMotion(driver) {
    const { protocol, hostname, port, path: driverPath } = driver.options;
    const endpoint = new URL(
        `${driverPath.replace(/\/?$/, '/')}session/${encodeURIComponent(driver.sessionId)}/ms/cdp/execute`,
        `${protocol}://${hostname}:${port}`
    );
    const response = await fetch(endpoint, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
            cmd: 'Emulation.setEmulatedMedia',
            params: { features: [{ name: 'prefers-reduced-motion', value: 'no-preference' }] },
        }),
        signal: AbortSignal.timeout(10000),
    });
    const result = await response.json();
    if (!response.ok || result.value?.error) {
        throw new Error(
            `Native normal-motion override failed (${response.status}): ${JSON.stringify(result.value)}`
        );
    }
    const environment = await driver.execute(async () => {
        if (document.visibilityState === 'visible') {
            await new Promise((resolve, reject) => {
                let pendingFrame;
                const deadline = setTimeout(() => {
                    cancelAnimationFrame(pendingFrame);
                    reject(
                        new Error(
                            `Native media change did not render two frames (${document.visibilityState}).`
                        )
                    );
                }, 5000);
                pendingFrame = requestAnimationFrame(() => {
                    pendingFrame = requestAnimationFrame(() => {
                        clearTimeout(deadline);
                        resolve();
                    });
                });
            });
        }
        return {
            systemReducedMotion: matchMedia('(prefers-reduced-motion: reduce)').matches,
            applicationReducedMotion: document.documentElement.hasAttribute('data-reduced-motion'),
            visibility: document.visibilityState,
        };
    });
    if (
        environment.systemReducedMotion !== false ||
        environment.applicationReducedMotion !== false ||
        environment.visibility !== 'visible'
    ) {
        throw new Error(
            `Native acceptance requires a visible window with normal motion: ${JSON.stringify(environment)}`
        );
    }
    return environment;
}

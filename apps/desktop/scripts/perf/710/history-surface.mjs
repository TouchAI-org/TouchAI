export function selectHistorySurface({ originalHandle, handles, rowHandles }) {
    const handlesWithRows = new Set(rowHandles);
    if (handlesWithRows.has(originalHandle)) return originalHandle;
    return (
        handles.find((handle) => handle !== originalHandle && handlesWithRows.has(handle)) ?? null
    );
}

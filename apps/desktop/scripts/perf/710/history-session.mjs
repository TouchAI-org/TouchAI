export function seededSessionMessageId(historyLevel) {
    if (!Number.isInteger(historyLevel) || historyLevel < 1) return null;
    const role = historyLevel % 2 === 1 ? 'user' : 'assistant';
    return `${role}-${historyLevel}`;
}

export function isSeededSessionReady({ historyLevel, mountedMessageIds }) {
    const expectedId = seededSessionMessageId(historyLevel);
    return expectedId !== null && mountedMessageIds.includes(expectedId);
}

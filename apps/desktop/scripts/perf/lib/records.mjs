export function isValidRun(record) {
    return (
        record.valid !== false &&
        record.exitCode === 0 &&
        (record.signal === null || record.signal === undefined) &&
        (record.notificationFailures ?? 0) === 0
    );
}

export function measurementKey(item) {
    return [item.flow, item.block, item.sequenceIndex, item.arm, item.historyLevel || 0].join(':');
}

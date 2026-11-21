import { MAX_DISPLAY_STARTUP_ATTEMPTS } from './config.mjs';

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

function validMeasurementIdentity(item) {
    return (
        (item?.arm === 'baseline' || item?.arm === 'current') &&
        typeof item.flow === 'string' &&
        item.flow.length > 0 &&
        Number.isInteger(item.block) &&
        item.block > 0 &&
        Number.isInteger(item.sequenceIndex) &&
        item.sequenceIndex > 0 &&
        (item.historyLevel === undefined ||
            item.historyLevel === null ||
            (Number.isInteger(item.historyLevel) && item.historyLevel >= 0))
    );
}

function measurementIdentity(item) {
    return validMeasurementIdentity(item) ? measurementKey(item) : null;
}

export function validateRunHistory(records, events, plan) {
    const errors = new Set();
    const plannedKeys = new Set();
    const plannedItemsByKey = new Map();
    for (const item of plan) {
        const key = measurementIdentity(item);
        if (!key) {
            errors.add(
                `Run plan item ${JSON.stringify(item)} has an invalid measurement identity.`
            );
            continue;
        }
        if (plannedKeys.has(key)) errors.add(`Run plan contains duplicate slot ${key}.`);
        plannedKeys.add(key);
        plannedItemsByKey.set(key, item);
    }

    const launches = new Map();
    const terminals = new Map();
    records.forEach((record, index) => {
        if (!record || typeof record !== 'object') {
            errors.add(`Run record ${index + 1} is malformed.`);
            return;
        }
        if (typeof record.runId !== 'string' || record.runId.length === 0) {
            errors.add(`Run record ${index + 1} has no run ID.`);
            return;
        }
        if (record.type === 'run-launch') {
            const items = launches.get(record.runId) ?? [];
            items.push({ record, index });
            launches.set(record.runId, items);
            return;
        }
        if (record.type === 'run' || record.type === 'run-attempt') {
            const items = terminals.get(record.runId) ?? [];
            items.push({ record, index });
            terminals.set(record.runId, items);
            return;
        }
        errors.add(`Run record ${record.runId} has unknown type ${record.type}.`);
    });

    const allRunIds = new Set([...launches.keys(), ...terminals.keys()]);
    for (const runId of allRunIds) {
        const runLaunches = launches.get(runId) ?? [];
        const runTerminals = terminals.get(runId) ?? [];
        if (runLaunches.length === 0) {
            errors.add(`Terminal run ${runId} has no launch record.`);
        }
        if (runLaunches.length > 1) {
            errors.add(`Run ${runId} has ${runLaunches.length} launch records.`);
        }
        if (runTerminals.length === 0) {
            errors.add(`Run ${runId} has an unfinished launch.`);
            continue;
        }
        if (runTerminals.length > 1) {
            errors.add(`Run ${runId} has ${runTerminals.length} terminal records.`);
        }
        const launch = runLaunches[0];
        const terminal = runTerminals[0];
        if (!terminal) continue;
        if (launch && launch.index > terminal.index) {
            errors.add(`Run ${runId} has a terminal record before its launch.`);
        }
        const terminalKey = measurementIdentity(terminal.record);
        if (!terminalKey) {
            errors.add(`Run ${runId} has an invalid measurement identity.`);
        } else if (!plannedKeys.has(terminalKey)) {
            errors.add(`Run ${runId} is outside the persisted plan.`);
        } else if (plannedItemsByKey.get(terminalKey)?.fixture !== terminal.record.fixture) {
            errors.add(`Run ${runId} does not match the planned fixture.`);
        }
        if (launch) {
            const launchKey = measurementIdentity(launch.record);
            if (launchKey !== terminalKey) {
                errors.add(`Run ${runId} changes measurement identity between launch and result.`);
            }
            if (launch.record.attempt !== terminal.record.attempt) {
                errors.add(`Run ${runId} changes attempt number between launch and result.`);
            }
            if (launch.record.fixture !== terminal.record.fixture) {
                errors.add(`Run ${runId} changes fixture between launch and result.`);
            }
        }
        if (!Number.isInteger(terminal.record.attempt) || terminal.record.attempt < 1) {
            errors.add(`Run ${runId} has an invalid attempt number.`);
        }
        if (terminal.record.type === 'run') {
            if (!isValidRun(terminal.record)) {
                errors.add(`Terminal run ${runId} is invalid.`);
            }
        } else if (
            terminal.record.valid !== false ||
            isValidRun(terminal.record) ||
            terminal.record.retryReason !== 'display-startup-failure'
        ) {
            errors.add(`Run ${runId} has an unapproved retry attempt.`);
        }
    }

    const successfulByKey = new Map();
    const attemptsByKey = new Map();
    const terminalsByKey = new Map();
    for (const runTerminals of terminals.values()) {
        for (const { record } of runTerminals) {
            const key = measurementIdentity(record);
            if (!key) continue;
            const attempts = attemptsByKey.get(key) ?? 0;
            attemptsByKey.set(key, attempts + 1);
            const grouped = terminalsByKey.get(key) ?? [];
            grouped.push(record);
            terminalsByKey.set(key, grouped);
            if (record.type !== 'run' || !isValidRun(record)) continue;
            const existing = successfulByKey.get(key);
            if (existing) {
                errors.add(`Runs ${existing.runId} and ${record.runId} share planned slot ${key}.`);
            } else {
                successfulByKey.set(key, record);
            }
        }
    }

    for (const [key, grouped] of terminalsByKey) {
        const attemptNumbers = grouped.map((record) => record.attempt);
        if (new Set(attemptNumbers).size !== attemptNumbers.length) {
            errors.add(`Planned slot ${key} has duplicate attempt numbers.`);
        }
        if (grouped.length > MAX_DISPLAY_STARTUP_ATTEMPTS) {
            errors.add(
                `Planned slot ${key} has ${grouped.length} attempts; the limit is ${MAX_DISPLAY_STARTUP_ATTEMPTS}.`
            );
        }
        const orderedAttempts = [...attemptNumbers].sort((left, right) => left - right);
        const approvedAttempts =
            orderedAttempts.length === 1 && orderedAttempts[0] === 1
                ? true
                : orderedAttempts.length === 2 &&
                  orderedAttempts[0] === 1 &&
                  orderedAttempts[1] === 2;
        if (!approvedAttempts) {
            errors.add(`Planned slot ${key} has an unapproved attempt sequence.`);
        }
        const retries = grouped.filter((record) => record.type === 'run-attempt');
        if (retries.length > 1 || retries.some((record) => record.attempt !== 1)) {
            errors.add(`Planned slot ${key} has an unapproved retry sequence.`);
        }
        if (
            grouped.some((record) => record.attempt === 2) &&
            !retries.some((record) => record.attempt === 1)
        ) {
            errors.add(`Planned slot ${key} skipped its approved startup retry.`);
        }
        const completed = grouped.find((record) => record.type === 'run' && isValidRun(record));
        if (completed && grouped.some((record) => record.attempt > completed.attempt)) {
            errors.add(`Planned slot ${key} continued after a successful run.`);
        }
    }

    const startsByRun = new Map();
    for (const event of events) {
        if (event?.type !== 'run-start') continue;
        const runId = event.runId;
        if (typeof runId !== 'string' || runId.length === 0) {
            errors.add('A run-start event has no run ID.');
            continue;
        }
        const starts = startsByRun.get(runId) ?? 0;
        startsByRun.set(runId, starts + 1);
        const terminal = terminals.get(runId)?.[0]?.record;
        if (!terminal) {
            errors.add(`Run ${runId} has an interrupted workload start.`);
        } else if (terminal.type !== 'run') {
            errors.add(`Retry attempt ${runId} unexpectedly started the workload.`);
        } else if (
            event.arm !== terminal.arm ||
            event.flow !== terminal.flow ||
            String(event.block) !== String(terminal.block)
        ) {
            errors.add(`Run ${runId} has a workload start with mismatched identity.`);
        }
    }

    for (const run of successfulByKey.values()) {
        const starts = startsByRun.get(run.runId) ?? 0;
        if (starts !== 1) {
            errors.add(`Successful run ${run.runId} has ${starts} workload start markers.`);
        }
    }

    return {
        errors: [...errors],
        successfulRuns: [...successfulByKey.values()],
        completedKeys: new Set(successfulByKey.keys()),
        attemptsByKey,
    };
}

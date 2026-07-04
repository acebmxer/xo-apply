import { deepEqual } from './patterns.js';
export const SEQUENCE_METHOD = 'schedule.runSequence';
export function sequenceSpecToDesired(spec) {
    return {
        name: spec.name,
        steps: spec.steps.map(s => ({ job: s.job, schedule: s.schedule })),
        cron: spec.cron,
        enabled: spec.enabled,
        timezone: spec.timezone,
    };
}
/** A call-job is a sequence iff it runs schedule.runSequence. */
export function isSequenceJob(job) {
    return job.type === 'call' && job.method === SEQUENCE_METHOD;
}
/** Pull the ordered schedule-id list out of a sequence job's paramsVector. */
export function extractSequenceScheduleIds(job) {
    const items = job.paramsVector?.items;
    if (!Array.isArray(items) || items.length === 0) {
        return [];
    }
    const values = items[0]?.values;
    if (!Array.isArray(values) || values.length === 0) {
        return [];
    }
    const schedules = values[0]?.schedules;
    return Array.isArray(schedules) ? schedules.filter(s => typeof s === 'string') : [];
}
/** Build the paramsVector XO expects for a schedule.runSequence job. */
export function buildParamsVector(scheduleIds) {
    return {
        type: 'crossProduct',
        items: [{ type: 'set', values: [{ schedules: scheduleIds }] }],
    };
}
/**
 * Diff a desired sequence against its actual call-job + trigger schedule.
 * `resolvedScheduleIds` is the desired ordered schedule-id list, already
 * resolved from (job, schedule) names to real XO ids. When a referenced
 * schedule can't be resolved yet (its job is being created in the same run)
 * pass undefined to skip the ordering comparison — apply will set it.
 */
export function diffSequence(desired, actual, resolvedScheduleIds) {
    const changes = [];
    if (resolvedScheduleIds !== undefined) {
        const actualIds = extractSequenceScheduleIds(actual.job);
        // order matters for sequences, so compare the arrays directly
        if (!deepEqual(resolvedScheduleIds, actualIds)) {
            changes.push({ field: 'steps', from: actualIds, to: resolvedScheduleIds });
        }
    }
    const sched = actual.schedule;
    if (sched === undefined) {
        changes.push({ field: 'schedule', from: '(missing)', to: `${desired.cron}` });
    }
    else {
        if (desired.cron !== sched.cron) {
            changes.push({ field: 'cron', from: sched.cron, to: desired.cron });
        }
        if (desired.enabled !== (sched.enabled ?? false)) {
            changes.push({ field: 'enabled', from: sched.enabled ?? false, to: desired.enabled });
        }
        if (desired.timezone !== undefined && desired.timezone !== sched.timezone) {
            changes.push({ field: 'timezone', from: sched.timezone, to: desired.timezone });
        }
    }
    return changes.length > 0 ? { changes } : { changes: [] };
}

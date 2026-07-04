import { deepEqual, extractIds, idPattern } from './patterns.js';
import { matchSchedules } from './backup-jobs.js';
export function metadataSpecToDesired(spec) {
    return {
        name: spec.name,
        xoMetadata: spec.xoMetadata,
        poolIds: spec.pools,
        remoteNames: spec.remotes,
        settings: spec.settings,
        schedules: spec.schedules.map(metadataScheduleSpecToDesired),
    };
}
function metadataScheduleSpecToDesired(spec) {
    return {
        name: spec.name,
        cron: spec.cron,
        enabled: spec.enabled,
        timezone: spec.timezone,
        poolRetention: spec.poolRetention,
        xoRetention: spec.xoRetention,
        settings: spec.settings,
    };
}
function actualRemoteNames(job, mapping) {
    const ids = extractIds(job.remotes) ?? [];
    return ids.map(id => mapping.remoteNameById.get(id) ?? id);
}
/**
 * Metadata schedules carry retention differently than VM backups. We reuse the
 * generic matchSchedules but adapt the DesiredMetadataSchedule to the minimal
 * shape it needs (name + cron).
 */
export function diffMetadataJob(desired, actual, mapping) {
    const changes = [];
    const { job } = actual;
    if (desired.xoMetadata !== (job.xoMetadata ?? false)) {
        changes.push({ field: 'xoMetadata', from: job.xoMetadata ?? false, to: desired.xoMetadata });
    }
    const actualPools = extractIds(job.pools) ?? [];
    if (!deepEqual([...desired.poolIds].sort(), [...actualPools].sort())) {
        changes.push({ field: 'pools', from: actualPools, to: desired.poolIds });
    }
    const actualRemotes = actualRemoteNames(job, mapping);
    if (!deepEqual([...desired.remoteNames].sort(), [...actualRemotes].sort())) {
        changes.push({ field: 'remotes', from: actualRemotes, to: desired.remoteNames });
    }
    const actualGlobal = job.settings[''] ?? {};
    for (const [key, value] of Object.entries(desired.settings)) {
        if (!deepEqual(value, actualGlobal[key])) {
            changes.push({ field: `settings.${key}`, from: actualGlobal[key], to: value });
        }
    }
    const scheduleChanges = [];
    const { pairs, unmatchedDesired, unmatchedActual } = matchSchedules(desired.schedules.map(toGenericSchedule), actual.schedules);
    const desiredByName = new Map(desired.schedules.map(s => [s.name, s]));
    for (const d of unmatchedDesired) {
        scheduleChanges.push({ kind: 'create', desired: d });
    }
    for (const a of unmatchedActual) {
        scheduleChanges.push({ kind: 'delete', actual: a });
    }
    for (const [d, a] of pairs) {
        const md = desiredByName.get(d.name);
        const schedChanges = [];
        if (d.cron !== a.cron) {
            schedChanges.push({ field: 'cron', from: a.cron, to: d.cron });
        }
        if (d.enabled !== (a.enabled ?? false)) {
            schedChanges.push({ field: 'enabled', from: a.enabled ?? false, to: d.enabled });
        }
        if (md?.timezone !== undefined && md.timezone !== a.timezone) {
            schedChanges.push({ field: 'timezone', from: a.timezone, to: md.timezone });
        }
        if ((d.name || undefined) !== (a.name || undefined)) {
            schedChanges.push({ field: 'name', from: a.name, to: d.name });
        }
        const schedSettings = job.settings[a.id] ?? {};
        if (md?.poolRetention !== undefined && !deepEqual(md.poolRetention, schedSettings.retentionPoolMetadata)) {
            schedChanges.push({ field: 'poolRetention', from: schedSettings.retentionPoolMetadata, to: md.poolRetention });
        }
        if (md?.xoRetention !== undefined && !deepEqual(md.xoRetention, schedSettings.retentionXoMetadata)) {
            schedChanges.push({ field: 'xoRetention', from: schedSettings.retentionXoMetadata, to: md.xoRetention });
        }
        for (const [key, value] of Object.entries(md?.settings ?? {})) {
            if (!deepEqual(value, schedSettings[key])) {
                schedChanges.push({ field: `settings.${key}`, from: schedSettings[key], to: value });
            }
        }
        if (schedChanges.length > 0) {
            scheduleChanges.push({ kind: 'update', desired: d, actual: a, changes: schedChanges });
        }
    }
    return { changes, scheduleChanges };
}
/** Adapt a metadata schedule to the generic DesiredSchedule matchSchedules needs. */
function toGenericSchedule(s) {
    return { name: s.name, cron: s.cron, enabled: s.enabled, timezone: s.timezone, settings: {} };
}
/** Build the per-schedule XO settings object for a metadata schedule. */
export function metadataScheduleSettings(s) {
    return {
        ...s.settings,
        ...(s.poolRetention !== undefined ? { retentionPoolMetadata: s.poolRetention } : {}),
        ...(s.xoRetention !== undefined ? { retentionXoMetadata: s.xoRetention } : {}),
    };
}
export { idPattern };

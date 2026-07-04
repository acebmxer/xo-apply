import { deepEqual, extractIds } from './patterns.js';
import { matchSchedules } from './backup-jobs.js';
export function mirrorSpecToDesired(spec) {
    return {
        name: spec.name,
        mode: spec.mode,
        sourceRemoteName: spec.sourceRemote,
        remoteNames: spec.remotes,
        settings: spec.settings,
        schedules: spec.schedules.map(mirrorScheduleSpecToDesired),
    };
}
function mirrorScheduleSpecToDesired(spec) {
    return {
        name: spec.name,
        cron: spec.cron,
        enabled: spec.enabled,
        timezone: spec.timezone,
        retention: spec.retention,
        settings: spec.settings,
    };
}
export function diffMirrorJob(desired, actual, mapping) {
    const changes = [];
    const { job } = actual;
    if (desired.mode !== job.mode) {
        changes.push({ field: 'mode', from: job.mode, to: desired.mode });
    }
    const actualSource = job.sourceRemote !== undefined ? mapping.remoteNameById.get(job.sourceRemote) ?? job.sourceRemote : undefined;
    if (desired.sourceRemoteName !== actualSource) {
        changes.push({ field: 'sourceRemote', from: actualSource, to: desired.sourceRemoteName });
    }
    const actualRemotes = (extractIds(job.remotes) ?? []).map(id => mapping.remoteNameById.get(id) ?? id);
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
        if (md?.retention !== undefined && !deepEqual(md.retention, schedSettings.exportRetention ?? 0)) {
            schedChanges.push({ field: 'retention', from: schedSettings.exportRetention ?? 0, to: md.retention });
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
function toGenericSchedule(s) {
    return { name: s.name, cron: s.cron, enabled: s.enabled, timezone: s.timezone, settings: {} };
}
export function mirrorScheduleSettings(s) {
    return {
        ...s.settings,
        ...(s.retention !== undefined ? { exportRetention: s.retention } : {}),
    };
}

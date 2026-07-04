import { deepEqual, extractIds, idPattern, patternsEqual, tagsPattern } from './patterns.js';
export function buildVmIndex(vms) {
    const vmIdsByName = new Map();
    for (const vm of vms) {
        const ids = vmIdsByName.get(vm.name_label) ?? [];
        ids.push(vm.id);
        vmIdsByName.set(vm.name_label, ids);
    }
    return { vmIdsByName };
}
export function jobSpecToDesired(spec, ctx) {
    let vms;
    const selector = spec.vms;
    if (selector.raw !== undefined) {
        vms = selector.raw;
    }
    else if (selector.uuids !== undefined) {
        vms = idPattern(selector.uuids);
    }
    else if (selector.names !== undefined) {
        const ids = [];
        for (const name of selector.names) {
            const found = ctx.vmIdsByName.get(name);
            if (found === undefined) {
                throw new Error(`backup job "${spec.name}": no VM found with name "${name}"`);
            }
            if (found.length > 1) {
                throw new Error(`backup job "${spec.name}": VM name "${name}" is ambiguous (${found.length} VMs); use vms.uuids instead`);
            }
            ids.push(found[0]);
        }
        vms = idPattern(ids);
    }
    else {
        const tags = selector.tags ?? [selector.tag];
        vms = tagsPattern(tags);
    }
    return {
        name: spec.name,
        mode: spec.mode,
        compression: spec.compression,
        vms,
        remoteNames: spec.remotes,
        srIds: spec.srs,
        settings: spec.settings,
        schedules: spec.schedules.map(scheduleSpecToDesired),
    };
}
function scheduleSpecToDesired(spec) {
    return {
        name: spec.name,
        cron: spec.cron,
        enabled: spec.enabled,
        timezone: spec.timezone,
        retention: spec.retention,
        snapshotRetention: spec.snapshotRetention,
        settings: spec.settings,
    };
}
/** Actual remote ids → names for comparison; unknown ids stay as ids. */
function actualRemoteNames(job, mapping) {
    const ids = extractIds(job.remotes) ?? [];
    return ids.map(id => mapping.remoteNameById.get(id) ?? id);
}
/**
 * Match actual schedules to desired ones: by name first, then by cron for
 * schedules XO created without a name.
 */
export function matchSchedules(desired, actual) {
    const remainingActual = [...actual];
    const pairs = [];
    const unmatchedDesired = [];
    for (const d of desired) {
        let index = remainingActual.findIndex(a => a.name === d.name);
        if (index === -1) {
            index = remainingActual.findIndex(a => (a.name === undefined || a.name === '') && a.cron === d.cron);
        }
        if (index === -1) {
            unmatchedDesired.push(d);
        }
        else {
            pairs.push([d, remainingActual[index]]);
            remainingActual.splice(index, 1);
        }
    }
    return { pairs, unmatchedDesired, unmatchedActual: remainingActual };
}
export function diffJob(desired, actual, mapping) {
    const changes = [];
    const { job } = actual;
    if (desired.mode !== job.mode) {
        changes.push({ field: 'mode', from: job.mode, to: desired.mode });
    }
    const actualCompression = job.compression === '' ? undefined : job.compression;
    if (desired.compression !== actualCompression) {
        changes.push({ field: 'compression', from: actualCompression, to: desired.compression });
    }
    if (!patternsEqual(desired.vms, job.vms)) {
        changes.push({ field: 'vms', from: job.vms, to: desired.vms });
    }
    const actualRemotes = actualRemoteNames(job, mapping);
    if (!deepEqual([...desired.remoteNames].sort(), [...actualRemotes].sort())) {
        changes.push({ field: 'remotes', from: actualRemotes, to: desired.remoteNames });
    }
    const actualSrs = extractIds(job.srs) ?? [];
    if (!deepEqual([...desired.srIds].sort(), [...actualSrs].sort())) {
        changes.push({ field: 'srs', from: actualSrs, to: desired.srIds });
    }
    const actualGlobal = job.settings[''] ?? {};
    for (const [key, value] of Object.entries(desired.settings)) {
        if (!deepEqual(value, actualGlobal[key])) {
            changes.push({ field: `settings.${key}`, from: actualGlobal[key], to: value });
        }
    }
    const scheduleChanges = [];
    const { pairs, unmatchedDesired, unmatchedActual } = matchSchedules(desired.schedules, actual.schedules);
    for (const d of unmatchedDesired) {
        scheduleChanges.push({ kind: 'create', desired: d });
    }
    for (const a of unmatchedActual) {
        scheduleChanges.push({ kind: 'delete', actual: a });
    }
    for (const [d, a] of pairs) {
        const schedChanges = [];
        if (d.cron !== a.cron) {
            schedChanges.push({ field: 'cron', from: a.cron, to: d.cron });
        }
        if (d.enabled !== (a.enabled ?? false)) {
            schedChanges.push({ field: 'enabled', from: a.enabled ?? false, to: d.enabled });
        }
        if (d.timezone !== undefined && d.timezone !== a.timezone) {
            schedChanges.push({ field: 'timezone', from: a.timezone, to: d.timezone });
        }
        if ((d.name || undefined) !== (a.name || undefined)) {
            schedChanges.push({ field: 'name', from: a.name, to: d.name });
        }
        const schedSettings = job.settings[a.id] ?? {};
        if (d.retention !== undefined && !deepEqual(d.retention, schedSettings.exportRetention ?? 0)) {
            schedChanges.push({ field: 'retention', from: schedSettings.exportRetention ?? 0, to: d.retention });
        }
        if (d.snapshotRetention !== undefined &&
            !deepEqual(d.snapshotRetention, schedSettings.snapshotRetention ?? 0)) {
            schedChanges.push({ field: 'snapshotRetention', from: schedSettings.snapshotRetention ?? 0, to: d.snapshotRetention });
        }
        for (const [key, value] of Object.entries(d.settings)) {
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

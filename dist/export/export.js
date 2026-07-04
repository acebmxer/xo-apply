import { stringify } from 'yaml';
import { extractIds, extractTags } from '../resources/patterns.js';
import { remoteToSpec } from '../resources/remotes.js';
/** Convert live XO state into a v1 spec document. */
export function exportSpec(actual) {
    const warnings = [];
    const remotes = [];
    for (const remote of actual.remotes) {
        try {
            const { spec, secretEnvVar } = remoteToSpec(remote);
            remotes.push(spec);
            if (secretEnvVar !== undefined) {
                warnings.push(`remote "${remote.name}": secret replaced by \${env:${secretEnvVar}} — set that environment variable before running apply`);
            }
        }
        catch (error) {
            warnings.push(`skipped remote "${remote.name}": ${error.message}`);
        }
    }
    const remoteNameById = new Map(actual.remotes.map(r => [r.id, r.name]));
    const vmNameById = new Map(actual.vms.map(vm => [vm.id, vm.name_label]));
    const vmIdsByName = new Map();
    for (const vm of actual.vms) {
        vmIdsByName.set(vm.name_label, (vmIdsByName.get(vm.name_label) ?? 0) + 1);
    }
    const schedulesByJob = new Map();
    for (const schedule of actual.schedules) {
        const list = schedulesByJob.get(schedule.jobId) ?? [];
        list.push(schedule);
        schedulesByJob.set(schedule.jobId, list);
    }
    const backupJobs = [];
    for (const job of actual.jobs) {
        const spec = {
            name: job.name,
            mode: job.mode,
        };
        if (job.compression !== undefined && job.compression !== '') {
            spec.compression = job.compression;
        }
        // vms selector
        const tags = extractTags(job.vms);
        const ids = tags === undefined ? extractIds(job.vms) : undefined;
        if (tags !== undefined) {
            spec.vms = tags.length === 1 ? { tag: tags[0] } : { tags };
        }
        else if (ids !== undefined) {
            const names = [];
            let useNames = true;
            for (const id of ids) {
                const name = vmNameById.get(id);
                if (name === undefined || (vmIdsByName.get(name) ?? 0) > 1) {
                    useNames = false;
                    break;
                }
                names.push(name);
            }
            if (useNames) {
                spec.vms = { names };
            }
            else {
                spec.vms = { uuids: ids };
                warnings.push(`backup job "${job.name}": exported VM selection as uuids (some VMs are missing or have ambiguous names)`);
            }
        }
        else {
            spec.vms = { raw: job.vms };
            warnings.push(`backup job "${job.name}": complex smart-mode pattern exported as vms.raw`);
        }
        // remotes
        const remoteIds = extractIds(job.remotes) ?? [];
        const remoteNames = [];
        for (const id of remoteIds) {
            const name = remoteNameById.get(id);
            if (name === undefined) {
                warnings.push(`backup job "${job.name}": references unknown remote id ${id}; exported as-is`);
                remoteNames.push(id);
            }
            else {
                remoteNames.push(name);
            }
        }
        if (remoteNames.length > 0) {
            spec.remotes = remoteNames;
        }
        // global settings
        const globalSettings = { ...(job.settings[''] ?? {}) };
        if (Object.keys(globalSettings).length > 0) {
            spec.settings = globalSettings;
        }
        // schedules
        const schedules = schedulesByJob.get(job.id) ?? [];
        spec.schedules = schedules.map((schedule, i) => {
            const schedSpec = {
                name: schedule.name && schedule.name !== '' ? schedule.name : `schedule-${i + 1}`,
                cron: schedule.cron,
            };
            if (schedule.enabled === false) {
                schedSpec.enabled = false;
            }
            if (schedule.timezone !== undefined) {
                schedSpec.timezone = schedule.timezone;
            }
            const schedSettings = job.settings[schedule.id] ?? {};
            if (typeof schedSettings.exportRetention === 'number' && schedSettings.exportRetention > 0) {
                schedSpec.retention = schedSettings.exportRetention;
            }
            if (typeof schedSettings.snapshotRetention === 'number' && schedSettings.snapshotRetention > 0) {
                schedSpec.snapshotRetention = schedSettings.snapshotRetention;
            }
            // preserve any other per-schedule settings (fullInterval, health checks…)
            const extra = Object.fromEntries(Object.entries(schedSettings).filter(([key]) => key !== 'exportRetention' && key !== 'snapshotRetention'));
            if (Object.keys(extra).length > 0) {
                schedSpec.settings = extra;
            }
            return schedSpec;
        });
        backupJobs.push(spec);
    }
    const doc = {};
    doc.remotes = remotes;
    doc.backupJobs = backupJobs;
    const header = `# Xen Orchestra configuration exported by xo-apply on ${new Date().toISOString()}\n` +
        `# Secrets are NOT exported: \${env:...} placeholders must be provided as environment variables.\n`;
    return { yaml: header + stringify(doc), warnings };
}

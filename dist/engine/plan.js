import { buildVmIndex, diffJob, jobSpecToDesired, } from '../resources/backup-jobs.js';
import { diffRemote, remoteSpecToDesired } from '../resources/remotes.js';
export function buildPlan(spec, actual) {
    const remotesManaged = spec.remotes !== undefined;
    const jobsManaged = spec.backupJobs !== undefined;
    const actualRemoteByName = new Map(actual.remotes.map(r => [r.name, r]));
    const remotePlans = [];
    const pendingRemoteNames = new Set();
    for (const remoteSpec of spec.remotes ?? []) {
        const desired = remoteSpecToDesired(remoteSpec);
        const existing = actualRemoteByName.get(remoteSpec.name);
        if (existing === undefined) {
            remotePlans.push({ kind: 'create', spec: remoteSpec, desired, changes: [] });
            pendingRemoteNames.add(remoteSpec.name);
        }
        else {
            const changes = diffRemote(desired, existing);
            remotePlans.push({
                kind: changes.length > 0 ? 'update' : 'noop',
                spec: remoteSpec,
                desired,
                actual: existing,
                changes,
            });
        }
    }
    const specRemoteNames = new Set((spec.remotes ?? []).map(r => r.name));
    const untrackedRemotes = remotesManaged ? actual.remotes.filter(r => !specRemoteNames.has(r.name)) : [];
    // -- jobs -----------------------------------------------------------------
    const mapping = {
        remoteNameById: new Map(actual.remotes.map(r => [r.id, r.name])),
        pendingRemoteNames,
    };
    const vmIndex = buildVmIndex(actual.vms);
    const schedulesByJob = new Map();
    for (const schedule of actual.schedules) {
        const list = schedulesByJob.get(schedule.jobId) ?? [];
        list.push(schedule);
        schedulesByJob.set(schedule.jobId, list);
    }
    const actualJobByName = new Map(actual.jobs.map(j => [j.name, j]));
    // validate that every referenced remote exists in the file or in XO
    const knownRemoteNames = new Set([...specRemoteNames, ...actual.remotes.map(r => r.name)]);
    const jobPlans = [];
    for (const jobSpec of spec.backupJobs ?? []) {
        for (const remoteName of jobSpec.remotes) {
            if (!knownRemoteNames.has(remoteName)) {
                throw new Error(`backup job "${jobSpec.name}" references remote "${remoteName}" which is neither in the config file nor in XO`);
            }
        }
        const desired = jobSpecToDesired(jobSpec, vmIndex);
        const existing = actualJobByName.get(jobSpec.name);
        if (existing === undefined) {
            jobPlans.push({
                kind: 'create',
                desired,
                diff: { changes: [], scheduleChanges: desired.schedules.map(s => ({ kind: 'create', desired: s })) },
            });
        }
        else {
            const actualJob = { job: existing, schedules: schedulesByJob.get(existing.id) ?? [] };
            const diff = diffJob(desired, actualJob, mapping);
            const kind = diff.changes.length > 0 || diff.scheduleChanges.length > 0 ? 'update' : 'noop';
            jobPlans.push({ kind, desired, actual: actualJob, diff });
        }
    }
    const specJobNames = new Set((spec.backupJobs ?? []).map(j => j.name));
    const untrackedJobs = jobsManaged ? actual.jobs.filter(j => !specJobNames.has(j.name)) : [];
    return {
        remotesManaged,
        jobsManaged,
        remotes: remotePlans,
        jobs: jobPlans,
        untrackedRemotes,
        untrackedJobs,
    };
}
export function planHasChanges(plan) {
    return plan.remotes.some(r => r.kind !== 'noop') || plan.jobs.some(j => j.kind !== 'noop');
}
export function planHasDrift(plan) {
    return planHasChanges(plan) || plan.untrackedRemotes.length > 0 || plan.untrackedJobs.length > 0;
}

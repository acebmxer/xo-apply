import { matchSchedules } from '../resources/backup-jobs.js';
import { metadataScheduleSettings } from '../resources/metadata-backups.js';
import { mirrorScheduleSettings } from '../resources/mirror-backups.js';
import { buildParamsVector, SEQUENCE_METHOD } from '../resources/sequences.js';
import { idPattern } from '../resources/patterns.js';
import { scheduleIndexKey, } from './plan.js';
export async function fetchActualState(client) {
    const [remotes, jobs, metadataJobs, mirrorJobs, callJobs, schedules, vms, users, groups] = await Promise.all([
        client.listRemotes(),
        client.listBackupJobs(),
        client.listMetadataBackupJobs(),
        client.listMirrorBackupJobs(),
        client.listCallJobs(),
        client.listSchedules(),
        client.listVms(),
        client.listUsers(),
        client.listGroups(),
    ]);
    return { remotes, jobs, metadataJobs, mirrorJobs, callJobs, schedules, vms, users, groups };
}
function scheduleCreateBody(desired) {
    return {
        cron: desired.cron,
        enabled: desired.enabled,
        name: desired.name,
        ...(desired.timezone !== undefined ? { timezone: desired.timezone } : {}),
    };
}
function retentionSettings(desired) {
    return {
        ...desired.settings,
        ...(desired.retention !== undefined ? { exportRetention: desired.retention } : {}),
        ...(desired.snapshotRetention !== undefined ? { snapshotRetention: desired.snapshotRetention } : {}),
    };
}
export async function applyPlan(client, plan, options = {}) {
    const prune = options.prune === true;
    const log = options.log ?? (() => { });
    // (jobName, scheduleName) → real XO schedule id, filled in as we create jobs
    // so sequences created later this run can resolve their step references.
    const scheduleIndex = new Map();
    // -- 1. remotes: create & update ------------------------------------------
    const remoteIdByName = new Map();
    for (const remote of plan.remotes) {
        if (remote.actual !== undefined) {
            remoteIdByName.set(remote.actual.name, remote.actual.id);
        }
    }
    for (const remote of plan.untrackedRemotes) {
        remoteIdByName.set(remote.name, remote.id);
    }
    for (const remote of plan.remotes) {
        if (remote.kind === 'create') {
            const { id } = await client.createRemote({
                name: remote.desired.name,
                url: remote.desired.url,
                ...(remote.desired.options !== undefined ? { options: remote.desired.options } : {}),
                ...(remote.desired.proxy !== undefined ? { proxy: remote.desired.proxy } : {}),
            });
            remoteIdByName.set(remote.desired.name, id);
            log(`created remote ${remote.desired.name}`);
        }
        else if (remote.kind === 'update' && remote.actual !== undefined) {
            const body = {};
            for (const change of remote.changes) {
                if (change.field === 'url') {
                    body.url = remote.desired.url;
                }
                else if (change.field === 'mountOptions') {
                    body.options = remote.desired.options ?? null;
                }
                else if (change.field === 'proxy') {
                    body.proxy = remote.desired.proxy ?? null;
                }
            }
            await client.updateRemote(remote.actual.id, body);
            log(`updated remote ${remote.desired.name}`);
        }
    }
    const resolveRemoteIds = (jobName, names) => names.map(name => {
        const id = remoteIdByName.get(name);
        if (id === undefined) {
            throw new Error(`job "${jobName}": remote "${name}" not found in XO after apply`);
        }
        return id;
    });
    const recordSchedule = (jobName, scheduleName, id) => {
        if (scheduleName) {
            scheduleIndex.set(scheduleIndexKey(jobName, scheduleName), id);
        }
    };
    // -- 2. VM backup jobs (incl. DR/CR) --------------------------------------
    for (const jobPlan of plan.jobs) {
        if (jobPlan.kind === 'create') {
            await createJob(client, jobPlan, resolveRemoteIds(jobPlan.desired.name, jobPlan.desired.remoteNames), recordSchedule);
            log(`created backup job ${jobPlan.desired.name}`);
        }
        else if (jobPlan.kind === 'update') {
            await updateJob(client, jobPlan, resolveRemoteIds(jobPlan.desired.name, jobPlan.desired.remoteNames), recordSchedule);
            log(`updated backup job ${jobPlan.desired.name}`);
        }
        else if (jobPlan.actual !== undefined) {
            for (const s of jobPlan.actual.schedules)
                recordSchedule(jobPlan.desired.name, s.name ?? '', s.id);
        }
    }
    // -- 3. metadata backup jobs ----------------------------------------------
    for (const jobPlan of plan.metadataJobs) {
        if (jobPlan.kind === 'create') {
            await createMetadataJob(client, jobPlan, resolveRemoteIds(jobPlan.desired.name, jobPlan.desired.remoteNames), recordSchedule);
            log(`created metadata backup ${jobPlan.desired.name}`);
        }
        else if (jobPlan.kind === 'update') {
            await updateMetadataJob(client, jobPlan, resolveRemoteIds(jobPlan.desired.name, jobPlan.desired.remoteNames), recordSchedule);
            log(`updated metadata backup ${jobPlan.desired.name}`);
        }
        else if (jobPlan.actual !== undefined) {
            for (const s of jobPlan.actual.schedules)
                recordSchedule(jobPlan.desired.name, s.name ?? '', s.id);
        }
    }
    // -- 4. mirror backup jobs ------------------------------------------------
    for (const jobPlan of plan.mirrorJobs) {
        const sourceId = resolveRemoteIds(jobPlan.desired.name, [jobPlan.desired.sourceRemoteName])[0];
        const targetIds = resolveRemoteIds(jobPlan.desired.name, jobPlan.desired.remoteNames);
        if (jobPlan.kind === 'create') {
            await createMirrorJob(client, jobPlan, sourceId, targetIds, recordSchedule);
            log(`created mirror backup ${jobPlan.desired.name}`);
        }
        else if (jobPlan.kind === 'update') {
            await updateMirrorJob(client, jobPlan, sourceId, targetIds, recordSchedule);
            log(`updated mirror backup ${jobPlan.desired.name}`);
        }
        else if (jobPlan.actual !== undefined) {
            for (const s of jobPlan.actual.schedules)
                recordSchedule(jobPlan.desired.name, s.name ?? '', s.id);
        }
    }
    // -- 5. sequences (resolve step schedule ids from the live index) ---------
    for (const seqPlan of plan.sequences) {
        if (seqPlan.kind === 'create' || seqPlan.kind === 'update') {
            await applySequence(client, seqPlan, scheduleIndex, seqPlan.kind, log);
        }
    }
    // -- 6. users (before groups, which reference them) -----------------------
    // email → real XO user id, seeded from actuals + untracked and grown as we
    // create users, so groups created this run can resolve their members.
    const userIdByEmail = new Map();
    for (const userPlan of plan.users) {
        if (userPlan.actual !== undefined) {
            userIdByEmail.set(userPlan.actual.email, userPlan.actual.id);
        }
    }
    for (const user of plan.untrackedUsers) {
        userIdByEmail.set(user.email, user.id);
    }
    for (const userPlan of plan.users) {
        const { desired } = userPlan;
        if (userPlan.kind === 'create') {
            // XO's user.create requires a password; a hand-written file may omit it.
            if (desired.password === undefined) {
                throw new Error(`user "${desired.email}": cannot create without a password — add a \`password:\` (or \`password: \${env:...}\`) line and re-apply`);
            }
            const id = await client.createUser({
                email: desired.email,
                password: desired.password,
                permission: desired.permission,
            });
            userIdByEmail.set(desired.email, id);
            log(`created user ${desired.email}`);
        }
        else if (userPlan.kind === 'update' && userPlan.actual !== undefined) {
            // Only permission is reconciled on update. The password is deliberately
            // NOT touched for an existing user: the file's password (often the
            // exported `ChangeMe` placeholder) would otherwise clobber whatever the
            // user has since set. Change an existing user's password in XO directly.
            const body = { id: userPlan.actual.id };
            if (userPlan.changes.some(c => c.field === 'permission')) {
                body.permission = desired.permission;
            }
            await client.setUser(body);
            log(`updated user ${desired.email}`);
        }
    }
    const resolveUserIds = (groupName, emails) => emails.map(email => {
        const id = userIdByEmail.get(email);
        if (id === undefined) {
            throw new Error(`group "${groupName}": user "${email}" not found in XO after apply`);
        }
        return id;
    });
    // -- 7. groups ------------------------------------------------------------
    for (const groupPlan of plan.groups) {
        const { desired } = groupPlan;
        if (groupPlan.kind === 'create') {
            const created = await client.createGroup({ name: desired.name });
            await client.setGroupUsers(created.id, resolveUserIds(desired.name, desired.memberEmails));
            log(`created group ${desired.name}`);
        }
        else if (groupPlan.kind === 'update' && groupPlan.actual !== undefined) {
            await client.setGroupUsers(groupPlan.actual.id, resolveUserIds(desired.name, desired.memberEmails));
            log(`updated group ${desired.name}`);
        }
    }
    // -- 8. prune (children before their remotes) -----------------------------
    if (prune) {
        // groups before users (reverse of create order); external users/groups are
        // never in the untracked lists, so they can never be pruned here.
        for (const group of plan.untrackedGroups) {
            await client.deleteGroup(group.id);
            log(`deleted group ${group.name}`);
        }
        for (const user of plan.untrackedUsers) {
            await client.deleteUser(user.id);
            log(`deleted user ${user.email}`);
        }
        for (const seq of plan.untrackedSequences) {
            await client.deleteCallJob(seq.id);
            log(`deleted sequence ${seq.name}`);
        }
        for (const job of plan.untrackedMirrorJobs) {
            await client.deleteMirrorBackupJob(job.id);
            log(`deleted mirror backup ${job.name}`);
        }
        for (const job of plan.untrackedMetadataJobs) {
            await client.deleteMetadataBackupJob(job.id);
            log(`deleted metadata backup ${job.name}`);
        }
        for (const job of plan.untrackedJobs) {
            await client.deleteBackupJob(job.id);
            log(`deleted backup job ${job.name}`);
        }
        for (const remote of plan.untrackedRemotes) {
            await client.deleteRemote(remote.id);
            log(`deleted remote ${remote.name}`);
        }
    }
}
// ---------------------------------------------------------------------------
// VM backup jobs
// ---------------------------------------------------------------------------
function targetPatterns(remoteIds, srIds) {
    const out = {};
    if (remoteIds.length > 0)
        out.remotes = idPattern(remoteIds);
    if (srIds.length > 0)
        out.srs = idPattern(srIds);
    return out;
}
async function createJob(client, jobPlan, remoteIds, record) {
    const { desired } = jobPlan;
    const settings = { '': { ...desired.settings } };
    const schedules = {};
    desired.schedules.forEach((schedule, i) => {
        const tmpId = `tmp_schedule_${i}`;
        schedules[tmpId] = scheduleCreateBody(schedule);
        const retention = retentionSettings(schedule);
        if (Object.keys(retention).length > 0) {
            settings[tmpId] = retention;
        }
    });
    await client.createBackupJob({
        name: desired.name,
        mode: desired.mode,
        ...(desired.compression !== undefined ? { compression: desired.compression } : {}),
        vms: desired.vms,
        ...targetPatterns(remoteIds, desired.srIds),
        settings,
        schedules,
    });
    await indexJobSchedules(client, desired.name, record);
}
async function updateJob(client, jobPlan, remoteIds, record) {
    const { desired, actual, diff } = jobPlan;
    if (actual === undefined) {
        throw new Error('updateJob called without actual state');
    }
    const jobId = actual.job.id;
    const { pairs, unmatchedDesired, unmatchedActual } = matchSchedules(desired.schedules, actual.schedules);
    const realScheduleId = new Map();
    const deletedScheduleIds = [];
    for (const schedule of unmatchedActual) {
        await client.deleteSchedule(schedule.id);
        deletedScheduleIds.push(schedule.id);
    }
    for (const [desiredSchedule, actualSchedule] of pairs) {
        realScheduleId.set(desiredSchedule, actualSchedule.id);
        const changed = desiredSchedule.cron !== actualSchedule.cron ||
            desiredSchedule.enabled !== (actualSchedule.enabled ?? false) ||
            (desiredSchedule.name || undefined) !== (actualSchedule.name || undefined) ||
            (desiredSchedule.timezone !== undefined && desiredSchedule.timezone !== actualSchedule.timezone);
        if (changed) {
            await client.setSchedule({
                id: actualSchedule.id,
                cron: desiredSchedule.cron,
                enabled: desiredSchedule.enabled,
                name: desiredSchedule.name,
                ...(desiredSchedule.timezone !== undefined ? { timezone: desiredSchedule.timezone } : {}),
            });
        }
        record(desired.name, desiredSchedule.name, actualSchedule.id);
    }
    for (const desiredSchedule of unmatchedDesired) {
        const created = await client.createSchedule({
            jobId,
            ...scheduleCreateBody(desiredSchedule),
        });
        realScheduleId.set(desiredSchedule, created.id);
        record(desired.name, desiredSchedule.name, created.id);
    }
    const settings = {};
    for (const [key, value] of Object.entries(actual.job.settings ?? {})) {
        if (!deletedScheduleIds.includes(key)) {
            settings[key] = { ...value };
        }
    }
    settings[''] = { ...(settings[''] ?? {}), ...desired.settings };
    for (const schedule of desired.schedules) {
        const id = realScheduleId.get(schedule);
        if (id !== undefined) {
            settings[id] = { ...(settings[id] ?? {}), ...retentionSettings(schedule) };
        }
    }
    const body = { id: jobId, settings };
    for (const change of diff.changes) {
        if (change.field === 'mode') {
            body.mode = desired.mode;
        }
        else if (change.field === 'compression') {
            body.compression = desired.compression ?? '';
        }
        else if (change.field === 'vms') {
            body.vms = desired.vms;
        }
        else if (change.field === 'remotes') {
            body.remotes = idPattern(remoteIds);
        }
        else if (change.field === 'srs') {
            body.srs = idPattern(desired.srIds);
        }
    }
    await client.editBackupJob(body);
}
// ---------------------------------------------------------------------------
// Metadata backup jobs
// ---------------------------------------------------------------------------
async function createMetadataJob(client, jobPlan, remoteIds, record) {
    const { desired } = jobPlan;
    const settings = { '': { ...desired.settings } };
    const schedules = {};
    desired.schedules.forEach((schedule, i) => {
        const tmpId = `tmp_schedule_${i}`;
        schedules[tmpId] = scheduleCreateBody(schedule);
        const s = metadataScheduleSettings(schedule);
        if (Object.keys(s).length > 0)
            settings[tmpId] = s;
    });
    await client.createMetadataBackupJob({
        name: desired.name,
        xoMetadata: desired.xoMetadata,
        ...(desired.poolIds.length > 0 ? { pools: idPattern(desired.poolIds) } : {}),
        remotes: idPattern(remoteIds),
        settings,
        schedules,
    });
    await indexJobSchedules(client, desired.name, record);
}
async function updateMetadataJob(client, jobPlan, remoteIds, record) {
    const { desired, actual, diff } = jobPlan;
    if (actual === undefined)
        throw new Error('updateMetadataJob called without actual state');
    const jobId = actual.job.id;
    const realId = await reconcileSchedules(client, jobId, desired.name, desired.schedules, actual.schedules, metadataScheduleSettings, record);
    const settings = mergeSettings(actual.job.settings, realId.deleted);
    settings[''] = { ...(settings[''] ?? {}), ...desired.settings };
    for (const [sched, id] of realId.byName) {
        const spec = desired.schedules.find(s => s.name === sched);
        if (spec)
            settings[id] = { ...(settings[id] ?? {}), ...metadataScheduleSettings(spec) };
    }
    const body = { id: jobId, settings };
    for (const change of diff.changes) {
        if (change.field === 'xoMetadata')
            body.xoMetadata = desired.xoMetadata;
        else if (change.field === 'pools')
            body.pools = desired.poolIds.length > 0 ? idPattern(desired.poolIds) : null;
        else if (change.field === 'remotes')
            body.remotes = idPattern(remoteIds);
    }
    await client.editMetadataBackupJob(body);
}
// ---------------------------------------------------------------------------
// Mirror backup jobs
// ---------------------------------------------------------------------------
async function createMirrorJob(client, jobPlan, sourceId, targetIds, record) {
    const { desired } = jobPlan;
    const settings = { '': { ...desired.settings } };
    const schedules = {};
    desired.schedules.forEach((schedule, i) => {
        const tmpId = `tmp_schedule_${i}`;
        schedules[tmpId] = scheduleCreateBody(schedule);
        const s = mirrorScheduleSettings(schedule);
        if (Object.keys(s).length > 0)
            settings[tmpId] = s;
    });
    await client.createMirrorBackupJob({
        name: desired.name,
        mode: desired.mode,
        sourceRemote: sourceId,
        remotes: idPattern(targetIds),
        settings,
        schedules,
    });
    await indexJobSchedules(client, desired.name, record);
}
async function updateMirrorJob(client, jobPlan, sourceId, targetIds, record) {
    const { desired, actual, diff } = jobPlan;
    if (actual === undefined)
        throw new Error('updateMirrorJob called without actual state');
    const jobId = actual.job.id;
    const realId = await reconcileSchedules(client, jobId, desired.name, desired.schedules, actual.schedules, mirrorScheduleSettings, record);
    const settings = mergeSettings(actual.job.settings, realId.deleted);
    settings[''] = { ...(settings[''] ?? {}), ...desired.settings };
    for (const [sched, id] of realId.byName) {
        const spec = desired.schedules.find(s => s.name === sched);
        if (spec)
            settings[id] = { ...(settings[id] ?? {}), ...mirrorScheduleSettings(spec) };
    }
    // mirrorBackup.editJob requires mode, sourceRemote and remotes every call
    const body = {
        id: jobId,
        mode: desired.mode,
        sourceRemote: sourceId,
        remotes: idPattern(targetIds),
        settings,
    };
    void diff;
    await client.editMirrorBackupJob(body);
}
// ---------------------------------------------------------------------------
// Sequences
// ---------------------------------------------------------------------------
async function applySequence(client, seqPlan, scheduleIndex, kind, log) {
    const { desired } = seqPlan;
    const scheduleIds = resolveSequenceSteps(desired, scheduleIndex);
    const paramsVector = buildParamsVector(scheduleIds);
    if (kind === 'create') {
        const createdJobId = await client.createCallJob({
            type: 'call',
            key: 'genericTask',
            method: SEQUENCE_METHOD,
            name: desired.name,
            paramsVector,
        });
        await client.createSchedule({
            jobId: createdJobId,
            cron: desired.cron,
            enabled: desired.enabled,
            name: '',
            ...(desired.timezone !== undefined ? { timezone: desired.timezone } : {}),
        });
        log(`created sequence ${desired.name}`);
    }
    else {
        const actual = seqPlan.actual;
        if (actual === undefined)
            throw new Error('update sequence without actual state');
        await client.setCallJob({ id: actual.job.id, name: desired.name, paramsVector });
        if (actual.schedule === undefined) {
            await client.createSchedule({
                jobId: actual.job.id,
                cron: desired.cron,
                enabled: desired.enabled,
                name: '',
                ...(desired.timezone !== undefined ? { timezone: desired.timezone } : {}),
            });
        }
        else {
            await client.setSchedule({
                id: actual.schedule.id,
                cron: desired.cron,
                enabled: desired.enabled,
                ...(desired.timezone !== undefined ? { timezone: desired.timezone } : {}),
            });
        }
        log(`updated sequence ${desired.name}`);
    }
}
function resolveSequenceSteps(desired, scheduleIndex) {
    return desired.steps.map(step => {
        const id = scheduleIndex.get(scheduleIndexKey(step.job, step.schedule));
        if (id === undefined) {
            throw new Error(`sequence "${desired.name}": step references schedule "${step.schedule}" of job "${step.job}", ` +
                `which was not found in XO. Define that job (with that named schedule) in the file or in XO.`);
        }
        return id;
    });
}
async function reconcileSchedules(client, jobId, jobName, desired, actual, _settingsOf, record) {
    const generic = desired.map(s => ({ name: s.name, cron: s.cron, enabled: s.enabled, timezone: s.timezone, settings: {} }));
    const { pairs, unmatchedDesired, unmatchedActual } = matchSchedules(generic, actual);
    const byName = new Map();
    const deleted = [];
    for (const schedule of unmatchedActual) {
        await client.deleteSchedule(schedule.id);
        deleted.push(schedule.id);
    }
    for (const [d, a] of pairs) {
        const spec = desired.find(s => s.name === d.name);
        const changed = spec.cron !== a.cron ||
            spec.enabled !== (a.enabled ?? false) ||
            (spec.name || undefined) !== (a.name || undefined) ||
            (spec.timezone !== undefined && spec.timezone !== a.timezone);
        if (changed) {
            await client.setSchedule({
                id: a.id,
                cron: spec.cron,
                enabled: spec.enabled,
                name: spec.name,
                ...(spec.timezone !== undefined ? { timezone: spec.timezone } : {}),
            });
        }
        byName.set(spec.name, a.id);
        record(jobName, spec.name, a.id);
    }
    for (const d of unmatchedDesired) {
        const spec = desired.find(s => s.name === d.name);
        const created = await client.createSchedule({
            jobId,
            cron: spec.cron,
            enabled: spec.enabled,
            name: spec.name,
            ...(spec.timezone !== undefined ? { timezone: spec.timezone } : {}),
        });
        byName.set(spec.name, created.id);
        record(jobName, spec.name, created.id);
    }
    return { byName, deleted };
}
function mergeSettings(actualSettings, deletedIds) {
    const settings = {};
    for (const [key, value] of Object.entries(actualSettings ?? {})) {
        if (!deletedIds.includes(key))
            settings[key] = { ...value };
    }
    return settings;
}
/**
 * After creating a job we don't know its new schedule ids. Re-list schedules
 * and record this job's named schedules into the sequence resolution index.
 */
async function indexJobSchedules(client, jobName, record) {
    // Find the job id by name across all kinds, then map its schedules.
    const [jobs, meta, mirror, schedules] = await Promise.all([
        client.listBackupJobs(),
        client.listMetadataBackupJobs(),
        client.listMirrorBackupJobs(),
        client.listSchedules(),
    ]);
    const match = [...jobs, ...meta, ...mirror].find(j => j.name === jobName);
    if (match === undefined)
        return;
    for (const s of schedules) {
        if (s.jobId === match.id && s.name)
            record(jobName, s.name, s.id);
    }
}

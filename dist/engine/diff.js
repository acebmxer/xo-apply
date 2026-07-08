import pc from 'picocolors';
import { maskUrl } from '../resources/remotes.js';
import { stableStringify } from '../resources/patterns.js';
function fmtValue(value) {
    if (value === undefined) {
        return '(unset)';
    }
    if (typeof value === 'string') {
        return value;
    }
    return stableStringify(value);
}
/** Render a plan as human-readable colored text. */
export function renderPlan(plan, { prune = false } = {}) {
    const lines = [];
    let creates = 0;
    let updates = 0;
    let deletes = 0;
    if (plan.remotesManaged) {
        lines.push(pc.bold('Remotes:'));
        for (const r of plan.remotes) {
            if (r.kind === 'create') {
                creates++;
                lines.push(pc.green(`  + create  ${r.desired.name}`) + pc.dim(`  (${maskUrl(r.desired.url)})`));
            }
            else if (r.kind === 'update') {
                updates++;
                lines.push(pc.yellow(`  ~ update  ${r.desired.name}`));
                for (const c of r.changes) {
                    lines.push(pc.yellow(`      ${c.field}: `) + pc.dim(`${fmtValue(c.from)} → ${fmtValue(c.to)}`));
                }
            }
            else {
                lines.push(pc.dim(`  = ok      ${r.desired.name}`));
            }
        }
        for (const r of plan.untrackedRemotes) {
            if (prune) {
                deletes++;
                lines.push(pc.red(`  - delete  ${r.name}`) + pc.dim(`  (${maskUrl(r.url)})`));
            }
            else {
                lines.push(pc.magenta(`  ! untracked  ${r.name}`) + pc.dim('  (not in file; use --prune to delete)'));
            }
        }
        if (plan.remotes.length === 0 && plan.untrackedRemotes.length === 0) {
            lines.push(pc.dim('  (none)'));
        }
        lines.push('');
    }
    if (plan.jobsManaged) {
        lines.push(pc.bold('Backup jobs:'));
        for (const j of plan.jobs) {
            if (j.kind === 'create') {
                creates++;
                const nSched = j.desired.schedules.length;
                lines.push(pc.green(`  + create  ${j.desired.name}`) +
                    pc.dim(`  (${j.desired.mode}, ${nSched} schedule${nSched === 1 ? '' : 's'})`));
            }
            else if (j.kind === 'update') {
                updates++;
                lines.push(pc.yellow(`  ~ update  ${j.desired.name}`));
                for (const c of j.diff.changes) {
                    lines.push(pc.yellow(`      ${c.field}: `) + pc.dim(`${fmtValue(c.from)} → ${fmtValue(c.to)}`));
                }
                for (const sc of j.diff.scheduleChanges) {
                    if (sc.kind === 'create') {
                        lines.push(pc.green(`      + schedule ${sc.desired.name}`) + pc.dim(`  (${sc.desired.cron})`));
                    }
                    else if (sc.kind === 'delete') {
                        lines.push(pc.red(`      - schedule ${sc.actual.name ?? sc.actual.id}`) + pc.dim(`  (${sc.actual.cron})`));
                    }
                    else {
                        lines.push(pc.yellow(`      ~ schedule ${sc.desired.name}`));
                        for (const c of sc.changes) {
                            lines.push(pc.yellow(`          ${c.field}: `) + pc.dim(`${fmtValue(c.from)} → ${fmtValue(c.to)}`));
                        }
                    }
                }
            }
            else {
                lines.push(pc.dim(`  = ok      ${j.desired.name}`));
            }
        }
        for (const j of plan.untrackedJobs) {
            if (prune) {
                deletes++;
                lines.push(pc.red(`  - delete  ${j.name}`) + pc.dim(`  (${j.mode})`));
            }
            else {
                lines.push(pc.magenta(`  ! untracked  ${j.name}`) + pc.dim('  (not in file; use --prune to delete)'));
            }
        }
        if (plan.jobs.length === 0 && plan.untrackedJobs.length === 0) {
            lines.push(pc.dim('  (none)'));
        }
        lines.push('');
    }
    const renderSimpleJobs = (title, managed, jobs, untrackedJobs, detail) => {
        if (!managed)
            return;
        lines.push(pc.bold(title + ':'));
        for (const j of jobs) {
            if (j.kind === 'create') {
                creates++;
                lines.push(pc.green(`  + create  ${j.desired.name}`) + pc.dim(`  (${detail(j.desired)})`));
            }
            else if (j.kind === 'update') {
                updates++;
                lines.push(pc.yellow(`  ~ update  ${j.desired.name}`));
                for (const c of j.diff.changes) {
                    lines.push(pc.yellow(`      ${c.field}: `) + pc.dim(`${fmtValue(c.from)} → ${fmtValue(c.to)}`));
                }
            }
            else {
                lines.push(pc.dim(`  = ok      ${j.desired.name}`));
            }
        }
        for (const j of untrackedJobs) {
            if (prune) {
                deletes++;
                lines.push(pc.red(`  - delete  ${j.name}`));
            }
            else {
                lines.push(pc.magenta(`  ! untracked  ${j.name}`) + pc.dim('  (not in file; use --prune to delete)'));
            }
        }
        if (jobs.length === 0 && untrackedJobs.length === 0) {
            lines.push(pc.dim('  (none)'));
        }
        lines.push('');
    };
    renderSimpleJobs('Metadata backups', plan.metadataManaged, plan.metadataJobs, plan.untrackedMetadataJobs, d => (d.xoMetadata ? 'XO metadata' : 'pool metadata'));
    renderSimpleJobs('Mirror backups', plan.mirrorManaged, plan.mirrorJobs, plan.untrackedMirrorJobs, d => `mirror ${d.mode}`);
    if (plan.sequencesManaged) {
        lines.push(pc.bold('Sequences:'));
        for (const s of plan.sequences) {
            if (s.kind === 'create') {
                creates++;
                lines.push(pc.green(`  + create  ${s.desired.name}`) + pc.dim(`  (${s.desired.steps.length} steps, ${s.desired.cron})`));
            }
            else if (s.kind === 'update') {
                updates++;
                lines.push(pc.yellow(`  ~ update  ${s.desired.name}`));
                for (const c of s.diff.changes) {
                    lines.push(pc.yellow(`      ${c.field}: `) + pc.dim(`${fmtValue(c.from)} → ${fmtValue(c.to)}`));
                }
            }
            else {
                lines.push(pc.dim(`  = ok      ${s.desired.name}`));
            }
        }
        for (const s of plan.untrackedSequences) {
            if (prune) {
                deletes++;
                lines.push(pc.red(`  - delete  ${s.name}`));
            }
            else {
                lines.push(pc.magenta(`  ! untracked  ${s.name}`) + pc.dim('  (not in file; use --prune to delete)'));
            }
        }
        if (plan.sequences.length === 0 && plan.untrackedSequences.length === 0) {
            lines.push(pc.dim('  (none)'));
        }
        lines.push('');
    }
    // Users / groups — like remotes, they carry per-field `changes` directly.
    const renderChangeItems = (title, managed, items, untracked, label, detail, trailer) => {
        if (!managed)
            return;
        lines.push(pc.bold(title + ':'));
        for (const it of items) {
            if (it.kind === 'create') {
                creates++;
                lines.push(pc.green(`  + create  ${label(it.desired)}`) + pc.dim(`  (${detail(it.desired)})`));
            }
            else if (it.kind === 'update') {
                updates++;
                lines.push(pc.yellow(`  ~ update  ${label(it.desired)}`));
                for (const c of it.changes) {
                    lines.push(pc.yellow(`      ${c.field}: `) + pc.dim(`${fmtValue(c.from)} → ${fmtValue(c.to)}`));
                }
            }
            else {
                lines.push(pc.dim(`  = ok      ${label(it.desired)}`));
            }
        }
        for (const u of untracked) {
            const name = u.name ?? u.email ?? u.host ?? '';
            if (prune) {
                deletes++;
                lines.push(pc.red(`  - delete  ${name}`));
            }
            else {
                lines.push(pc.magenta(`  ! untracked  ${name}`) + pc.dim('  (not in file; use --prune to delete)'));
            }
        }
        if (items.length === 0 && untracked.length === 0) {
            lines.push(pc.dim('  (none)'));
        }
        if (trailer)
            lines.push(pc.dim('  ' + trailer));
        lines.push('');
    };
    renderChangeItems('Users', plan.usersManaged, plan.users, plan.untrackedUsers, d => d.email, d => d.permission, plan.externalUserCount > 0 ? `${plan.externalUserCount} external user(s) unmanaged` : undefined);
    renderChangeItems('Groups', plan.groupsManaged, plan.groups, plan.untrackedGroups, d => d.name, d => `${d.memberEmails.length} member${d.memberEmails.length === 1 ? '' : 's'}`, plan.externalGroupCount > 0 ? `${plan.externalGroupCount} external group(s) unmanaged` : undefined);
    renderChangeItems('Servers', plan.serversManaged, plan.servers, plan.untrackedServers, d => d.host, d => (d.enabled ? d.label ?? d.username : `${d.label ?? d.username}, disabled`));
    if (!plan.remotesManaged &&
        !plan.jobsManaged &&
        !plan.metadataManaged &&
        !plan.mirrorManaged &&
        !plan.sequencesManaged &&
        !plan.usersManaged &&
        !plan.groupsManaged &&
        !plan.serversManaged) {
        lines.push(pc.dim('Nothing is managed by this file (no remotes/backupJobs/metadataBackups/mirrorBackups/sequences/users/groups/servers sections).'));
        lines.push('');
    }
    const untracked = plan.untrackedRemotes.length +
        plan.untrackedJobs.length +
        plan.untrackedMetadataJobs.length +
        plan.untrackedMirrorJobs.length +
        plan.untrackedSequences.length +
        plan.untrackedUsers.length +
        plan.untrackedGroups.length +
        plan.untrackedServers.length;
    const summaryParts = [
        pc.green(`${creates} to create`),
        pc.yellow(`${updates} to update`),
        prune ? pc.red(`${deletes} to delete`) : pc.magenta(`${untracked} untracked`),
    ];
    lines.push(pc.bold(`Plan: ${summaryParts.join(pc.dim(', '))}`));
    return lines.join('\n');
}

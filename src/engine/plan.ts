import type { Spec } from '../config/schema.js'
import type { XoBackupJob, XoRemote, XoSchedule, XoVm } from '../client/index.js'
import {
  buildVmIndex,
  diffJob,
  jobSpecToDesired,
  type ActualJob,
  type DesiredJob,
  type JobDiff,
  type RemoteMapping,
} from '../resources/backup-jobs.js'
import { diffRemote, remoteSpecToDesired, type DesiredRemote, type FieldChange } from '../resources/remotes.js'
import type { RemoteSpec } from '../config/schema.js'

export interface ActualState {
  remotes: XoRemote[]
  jobs: XoBackupJob[]
  schedules: XoSchedule[]
  vms: XoVm[]
}

export interface RemotePlan {
  kind: 'create' | 'update' | 'noop'
  spec: RemoteSpec
  desired: DesiredRemote
  actual?: XoRemote
  changes: FieldChange[]
}

export interface JobPlan {
  kind: 'create' | 'update' | 'noop'
  desired: DesiredJob
  actual?: ActualJob
  diff: JobDiff
}

export interface Plan {
  remotesManaged: boolean
  jobsManaged: boolean
  remotes: RemotePlan[]
  jobs: JobPlan[]
  /** exist in XO but not in the file — deleted only with --prune */
  untrackedRemotes: XoRemote[]
  untrackedJobs: XoBackupJob[]
}

export function buildPlan(spec: Spec, actual: ActualState): Plan {
  const remotesManaged = spec.remotes !== undefined
  const jobsManaged = spec.backupJobs !== undefined

  const actualRemoteByName = new Map(actual.remotes.map(r => [r.name, r]))
  const remotePlans: RemotePlan[] = []
  const pendingRemoteNames = new Set<string>()

  for (const remoteSpec of spec.remotes ?? []) {
    const desired = remoteSpecToDesired(remoteSpec)
    const existing = actualRemoteByName.get(remoteSpec.name)
    if (existing === undefined) {
      remotePlans.push({ kind: 'create', spec: remoteSpec, desired, changes: [] })
      pendingRemoteNames.add(remoteSpec.name)
    } else {
      const changes = diffRemote(desired, existing)
      remotePlans.push({
        kind: changes.length > 0 ? 'update' : 'noop',
        spec: remoteSpec,
        desired,
        actual: existing,
        changes,
      })
    }
  }

  const specRemoteNames = new Set((spec.remotes ?? []).map(r => r.name))
  const untrackedRemotes = remotesManaged ? actual.remotes.filter(r => !specRemoteNames.has(r.name)) : []

  // -- jobs -----------------------------------------------------------------

  const mapping: RemoteMapping = {
    remoteNameById: new Map(actual.remotes.map(r => [r.id, r.name])),
    pendingRemoteNames,
  }
  const vmIndex = buildVmIndex(actual.vms)
  const schedulesByJob = new Map<string, XoSchedule[]>()
  for (const schedule of actual.schedules) {
    const list = schedulesByJob.get(schedule.jobId) ?? []
    list.push(schedule)
    schedulesByJob.set(schedule.jobId, list)
  }
  const actualJobByName = new Map(actual.jobs.map(j => [j.name, j]))

  // validate that every referenced remote exists in the file or in XO
  const knownRemoteNames = new Set([...specRemoteNames, ...actual.remotes.map(r => r.name)])
  const jobPlans: JobPlan[] = []

  for (const jobSpec of spec.backupJobs ?? []) {
    for (const remoteName of jobSpec.remotes) {
      if (!knownRemoteNames.has(remoteName)) {
        throw new Error(
          `backup job "${jobSpec.name}" references remote "${remoteName}" which is neither in the config file nor in XO`
        )
      }
    }
    const desired = jobSpecToDesired(jobSpec, vmIndex)
    const existing = actualJobByName.get(jobSpec.name)
    if (existing === undefined) {
      jobPlans.push({
        kind: 'create',
        desired,
        diff: { changes: [], scheduleChanges: desired.schedules.map(s => ({ kind: 'create', desired: s })) },
      })
    } else {
      const actualJob: ActualJob = { job: existing, schedules: schedulesByJob.get(existing.id) ?? [] }
      const diff = diffJob(desired, actualJob, mapping)
      const kind = diff.changes.length > 0 || diff.scheduleChanges.length > 0 ? 'update' : 'noop'
      jobPlans.push({ kind, desired, actual: actualJob, diff })
    }
  }

  const specJobNames = new Set((spec.backupJobs ?? []).map(j => j.name))
  const untrackedJobs = jobsManaged ? actual.jobs.filter(j => !specJobNames.has(j.name)) : []

  return {
    remotesManaged,
    jobsManaged,
    remotes: remotePlans,
    jobs: jobPlans,
    untrackedRemotes,
    untrackedJobs,
  }
}

export function planHasChanges(plan: Plan): boolean {
  return plan.remotes.some(r => r.kind !== 'noop') || plan.jobs.some(j => j.kind !== 'noop')
}

export function planHasDrift(plan: Plan): boolean {
  return planHasChanges(plan) || plan.untrackedRemotes.length > 0 || plan.untrackedJobs.length > 0
}

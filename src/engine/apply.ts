import type { XoClient, XoSchedule } from '../client/index.js'
import { matchSchedules, type DesiredJob, type DesiredSchedule } from '../resources/backup-jobs.js'
import { metadataScheduleSettings, type DesiredMetadataJob, type DesiredMetadataSchedule } from '../resources/metadata-backups.js'
import { mirrorScheduleSettings, type DesiredMirrorJob, type DesiredMirrorSchedule } from '../resources/mirror-backups.js'
import { buildParamsVector, SEQUENCE_METHOD, type DesiredSequence } from '../resources/sequences.js'
import { idPattern } from '../resources/patterns.js'
import {
  scheduleIndexKey,
  type ActualState,
  type JobPlan,
  type MetadataJobPlan,
  type MirrorJobPlan,
  type Plan,
  type ScheduleIdIndex,
  type SequencePlan,
} from './plan.js'

export async function fetchActualState(client: XoClient): Promise<ActualState> {
  const [remotes, jobs, metadataJobs, mirrorJobs, callJobs, schedules, vms] = await Promise.all([
    client.listRemotes(),
    client.listBackupJobs(),
    client.listMetadataBackupJobs(),
    client.listMirrorBackupJobs(),
    client.listCallJobs(),
    client.listSchedules(),
    client.listVms(),
  ])
  return { remotes, jobs, metadataJobs, mirrorJobs, callJobs, schedules, vms }
}

export interface ApplyOptions {
  prune?: boolean
  log?: (message: string) => void
}

function scheduleCreateBody(desired: { cron: string; enabled: boolean; name: string; timezone?: string }): Record<string, unknown> {
  return {
    cron: desired.cron,
    enabled: desired.enabled,
    name: desired.name,
    ...(desired.timezone !== undefined ? { timezone: desired.timezone } : {}),
  }
}

function retentionSettings(desired: DesiredSchedule): Record<string, unknown> {
  return {
    ...desired.settings,
    ...(desired.retention !== undefined ? { exportRetention: desired.retention } : {}),
    ...(desired.snapshotRetention !== undefined ? { snapshotRetention: desired.snapshotRetention } : {}),
  }
}

export async function applyPlan(client: XoClient, plan: Plan, options: ApplyOptions = {}): Promise<void> {
  const prune = options.prune === true
  const log = options.log ?? (() => {})

  // (jobName, scheduleName) → real XO schedule id, filled in as we create jobs
  // so sequences created later this run can resolve their step references.
  const scheduleIndex: ScheduleIdIndex = new Map()

  // -- 1. remotes: create & update ------------------------------------------

  const remoteIdByName = new Map<string, string>()
  for (const remote of plan.remotes) {
    if (remote.actual !== undefined) {
      remoteIdByName.set(remote.actual.name, remote.actual.id)
    }
  }
  for (const remote of plan.untrackedRemotes) {
    remoteIdByName.set(remote.name, remote.id)
  }

  for (const remote of plan.remotes) {
    if (remote.kind === 'create') {
      const { id } = await client.createRemote({
        name: remote.desired.name,
        url: remote.desired.url,
        ...(remote.desired.options !== undefined ? { options: remote.desired.options } : {}),
        ...(remote.desired.proxy !== undefined ? { proxy: remote.desired.proxy } : {}),
      })
      remoteIdByName.set(remote.desired.name, id)
      log(`created remote ${remote.desired.name}`)
    } else if (remote.kind === 'update' && remote.actual !== undefined) {
      const body: Record<string, unknown> = {}
      for (const change of remote.changes) {
        if (change.field === 'url') {
          body.url = remote.desired.url
        } else if (change.field === 'mountOptions') {
          body.options = remote.desired.options ?? null
        } else if (change.field === 'proxy') {
          body.proxy = remote.desired.proxy ?? null
        }
      }
      await client.updateRemote(remote.actual.id, body)
      log(`updated remote ${remote.desired.name}`)
    }
  }

  const resolveRemoteIds = (jobName: string, names: string[]): string[] =>
    names.map(name => {
      const id = remoteIdByName.get(name)
      if (id === undefined) {
        throw new Error(`job "${jobName}": remote "${name}" not found in XO after apply`)
      }
      return id
    })

  const recordSchedule = (jobName: string, scheduleName: string, id: string) => {
    if (scheduleName) {
      scheduleIndex.set(scheduleIndexKey(jobName, scheduleName), id)
    }
  }

  // -- 2. VM backup jobs (incl. DR/CR) --------------------------------------

  for (const jobPlan of plan.jobs) {
    if (jobPlan.kind === 'create') {
      await createJob(client, jobPlan, resolveRemoteIds(jobPlan.desired.name, jobPlan.desired.remoteNames), recordSchedule)
      log(`created backup job ${jobPlan.desired.name}`)
    } else if (jobPlan.kind === 'update') {
      await updateJob(client, jobPlan, resolveRemoteIds(jobPlan.desired.name, jobPlan.desired.remoteNames), recordSchedule)
      log(`updated backup job ${jobPlan.desired.name}`)
    } else if (jobPlan.actual !== undefined) {
      for (const s of jobPlan.actual.schedules) recordSchedule(jobPlan.desired.name, s.name ?? '', s.id)
    }
  }

  // -- 3. metadata backup jobs ----------------------------------------------

  for (const jobPlan of plan.metadataJobs) {
    if (jobPlan.kind === 'create') {
      await createMetadataJob(client, jobPlan, resolveRemoteIds(jobPlan.desired.name, jobPlan.desired.remoteNames), recordSchedule)
      log(`created metadata backup ${jobPlan.desired.name}`)
    } else if (jobPlan.kind === 'update') {
      await updateMetadataJob(client, jobPlan, resolveRemoteIds(jobPlan.desired.name, jobPlan.desired.remoteNames), recordSchedule)
      log(`updated metadata backup ${jobPlan.desired.name}`)
    } else if (jobPlan.actual !== undefined) {
      for (const s of jobPlan.actual.schedules) recordSchedule(jobPlan.desired.name, s.name ?? '', s.id)
    }
  }

  // -- 4. mirror backup jobs ------------------------------------------------

  for (const jobPlan of plan.mirrorJobs) {
    const sourceId = resolveRemoteIds(jobPlan.desired.name, [jobPlan.desired.sourceRemoteName])[0]
    const targetIds = resolveRemoteIds(jobPlan.desired.name, jobPlan.desired.remoteNames)
    if (jobPlan.kind === 'create') {
      await createMirrorJob(client, jobPlan, sourceId, targetIds, recordSchedule)
      log(`created mirror backup ${jobPlan.desired.name}`)
    } else if (jobPlan.kind === 'update') {
      await updateMirrorJob(client, jobPlan, sourceId, targetIds, recordSchedule)
      log(`updated mirror backup ${jobPlan.desired.name}`)
    } else if (jobPlan.actual !== undefined) {
      for (const s of jobPlan.actual.schedules) recordSchedule(jobPlan.desired.name, s.name ?? '', s.id)
    }
  }

  // -- 5. sequences (resolve step schedule ids from the live index) ---------

  for (const seqPlan of plan.sequences) {
    if (seqPlan.kind === 'create' || seqPlan.kind === 'update') {
      await applySequence(client, seqPlan, scheduleIndex, seqPlan.kind, log)
    }
  }

  // -- 6. prune (children before their remotes) -----------------------------

  if (prune) {
    for (const seq of plan.untrackedSequences) {
      await client.deleteCallJob(seq.id)
      log(`deleted sequence ${seq.name}`)
    }
    for (const job of plan.untrackedMirrorJobs) {
      await client.deleteMirrorBackupJob(job.id)
      log(`deleted mirror backup ${job.name}`)
    }
    for (const job of plan.untrackedMetadataJobs) {
      await client.deleteMetadataBackupJob(job.id)
      log(`deleted metadata backup ${job.name}`)
    }
    for (const job of plan.untrackedJobs) {
      await client.deleteBackupJob(job.id)
      log(`deleted backup job ${job.name}`)
    }
    for (const remote of plan.untrackedRemotes) {
      await client.deleteRemote(remote.id)
      log(`deleted remote ${remote.name}`)
    }
  }
}

// ---------------------------------------------------------------------------
// VM backup jobs
// ---------------------------------------------------------------------------

function targetPatterns(remoteIds: string[], srIds: string[]): { remotes?: Record<string, unknown>; srs?: Record<string, unknown> } {
  const out: { remotes?: Record<string, unknown>; srs?: Record<string, unknown> } = {}
  if (remoteIds.length > 0) out.remotes = idPattern(remoteIds)
  if (srIds.length > 0) out.srs = idPattern(srIds)
  return out
}

async function createJob(
  client: XoClient,
  jobPlan: JobPlan,
  remoteIds: string[],
  record: (job: string, sched: string, id: string) => void
): Promise<void> {
  const { desired } = jobPlan
  const settings: Record<string, Record<string, unknown>> = { '': { ...desired.settings } }
  const schedules: Record<string, Record<string, unknown>> = {}

  desired.schedules.forEach((schedule, i) => {
    const tmpId = `tmp_schedule_${i}`
    schedules[tmpId] = scheduleCreateBody(schedule)
    const retention = retentionSettings(schedule)
    if (Object.keys(retention).length > 0) {
      settings[tmpId] = retention
    }
  })

  await client.createBackupJob({
    name: desired.name,
    mode: desired.mode,
    ...(desired.compression !== undefined ? { compression: desired.compression } : {}),
    vms: desired.vms,
    ...targetPatterns(remoteIds, desired.srIds),
    settings,
    schedules,
  })
  await indexJobSchedules(client, desired.name, record)
}

async function updateJob(
  client: XoClient,
  jobPlan: JobPlan,
  remoteIds: string[],
  record: (job: string, sched: string, id: string) => void
): Promise<void> {
  const { desired, actual, diff } = jobPlan
  if (actual === undefined) {
    throw new Error('updateJob called without actual state')
  }
  const jobId = actual.job.id
  const { pairs, unmatchedDesired, unmatchedActual } = matchSchedules(desired.schedules, actual.schedules)

  const realScheduleId = new Map<DesiredSchedule, string>()
  const deletedScheduleIds: string[] = []

  for (const schedule of unmatchedActual) {
    await client.deleteSchedule(schedule.id)
    deletedScheduleIds.push(schedule.id)
  }
  for (const [desiredSchedule, actualSchedule] of pairs) {
    realScheduleId.set(desiredSchedule, actualSchedule.id)
    const changed =
      desiredSchedule.cron !== actualSchedule.cron ||
      desiredSchedule.enabled !== (actualSchedule.enabled ?? false) ||
      (desiredSchedule.name || undefined) !== (actualSchedule.name || undefined) ||
      (desiredSchedule.timezone !== undefined && desiredSchedule.timezone !== actualSchedule.timezone)
    if (changed) {
      await client.setSchedule({
        id: actualSchedule.id,
        cron: desiredSchedule.cron,
        enabled: desiredSchedule.enabled,
        name: desiredSchedule.name,
        ...(desiredSchedule.timezone !== undefined ? { timezone: desiredSchedule.timezone } : {}),
      })
    }
    record(desired.name, desiredSchedule.name, actualSchedule.id)
  }
  for (const desiredSchedule of unmatchedDesired) {
    const created: XoSchedule = await client.createSchedule({
      jobId,
      ...scheduleCreateBody(desiredSchedule),
    } as Parameters<XoClient['createSchedule']>[0])
    realScheduleId.set(desiredSchedule, created.id)
    record(desired.name, desiredSchedule.name, created.id)
  }

  const settings: Record<string, Record<string, unknown>> = {}
  for (const [key, value] of Object.entries(actual.job.settings ?? {})) {
    if (!deletedScheduleIds.includes(key)) {
      settings[key] = { ...value }
    }
  }
  settings[''] = { ...(settings[''] ?? {}), ...desired.settings }
  for (const schedule of desired.schedules) {
    const id = realScheduleId.get(schedule)
    if (id !== undefined) {
      settings[id] = { ...(settings[id] ?? {}), ...retentionSettings(schedule) }
    }
  }

  const body: Record<string, unknown> = { id: jobId, settings }
  for (const change of diff.changes) {
    if (change.field === 'mode') {
      body.mode = desired.mode
    } else if (change.field === 'compression') {
      body.compression = desired.compression ?? ''
    } else if (change.field === 'vms') {
      body.vms = desired.vms
    } else if (change.field === 'remotes') {
      body.remotes = idPattern(remoteIds)
    } else if (change.field === 'srs') {
      body.srs = idPattern(desired.srIds)
    }
  }

  await client.editBackupJob(body as Record<string, unknown> & { id: string })
}

// ---------------------------------------------------------------------------
// Metadata backup jobs
// ---------------------------------------------------------------------------

async function createMetadataJob(
  client: XoClient,
  jobPlan: MetadataJobPlan,
  remoteIds: string[],
  record: (job: string, sched: string, id: string) => void
): Promise<void> {
  const { desired } = jobPlan
  const settings: Record<string, Record<string, unknown>> = { '': { ...desired.settings } }
  const schedules: Record<string, Record<string, unknown>> = {}
  desired.schedules.forEach((schedule, i) => {
    const tmpId = `tmp_schedule_${i}`
    schedules[tmpId] = scheduleCreateBody(schedule)
    const s = metadataScheduleSettings(schedule)
    if (Object.keys(s).length > 0) settings[tmpId] = s
  })

  await client.createMetadataBackupJob({
    name: desired.name,
    xoMetadata: desired.xoMetadata,
    ...(desired.poolIds.length > 0 ? { pools: idPattern(desired.poolIds) } : {}),
    remotes: idPattern(remoteIds),
    settings,
    schedules,
  })
  await indexJobSchedules(client, desired.name, record)
}

async function updateMetadataJob(
  client: XoClient,
  jobPlan: MetadataJobPlan,
  remoteIds: string[],
  record: (job: string, sched: string, id: string) => void
): Promise<void> {
  const { desired, actual, diff } = jobPlan
  if (actual === undefined) throw new Error('updateMetadataJob called without actual state')
  const jobId = actual.job.id
  const realId = await reconcileSchedules(
    client,
    jobId,
    desired.name,
    desired.schedules,
    actual.schedules,
    metadataScheduleSettings,
    record
  )

  const settings = mergeSettings(actual.job.settings, realId.deleted)
  settings[''] = { ...(settings[''] ?? {}), ...desired.settings }
  for (const [sched, id] of realId.byName) {
    const spec = desired.schedules.find(s => s.name === sched)
    if (spec) settings[id] = { ...(settings[id] ?? {}), ...metadataScheduleSettings(spec) }
  }

  const body: Record<string, unknown> = { id: jobId, settings }
  for (const change of diff.changes) {
    if (change.field === 'xoMetadata') body.xoMetadata = desired.xoMetadata
    else if (change.field === 'pools') body.pools = desired.poolIds.length > 0 ? idPattern(desired.poolIds) : null
    else if (change.field === 'remotes') body.remotes = idPattern(remoteIds)
  }
  await client.editMetadataBackupJob(body as Record<string, unknown> & { id: string })
}

// ---------------------------------------------------------------------------
// Mirror backup jobs
// ---------------------------------------------------------------------------

async function createMirrorJob(
  client: XoClient,
  jobPlan: MirrorJobPlan,
  sourceId: string,
  targetIds: string[],
  record: (job: string, sched: string, id: string) => void
): Promise<void> {
  const { desired } = jobPlan
  const settings: Record<string, Record<string, unknown>> = { '': { ...desired.settings } }
  const schedules: Record<string, Record<string, unknown>> = {}
  desired.schedules.forEach((schedule, i) => {
    const tmpId = `tmp_schedule_${i}`
    schedules[tmpId] = scheduleCreateBody(schedule)
    const s = mirrorScheduleSettings(schedule)
    if (Object.keys(s).length > 0) settings[tmpId] = s
  })

  await client.createMirrorBackupJob({
    name: desired.name,
    mode: desired.mode,
    sourceRemote: sourceId,
    remotes: idPattern(targetIds),
    settings,
    schedules,
  })
  await indexJobSchedules(client, desired.name, record)
}

async function updateMirrorJob(
  client: XoClient,
  jobPlan: MirrorJobPlan,
  sourceId: string,
  targetIds: string[],
  record: (job: string, sched: string, id: string) => void
): Promise<void> {
  const { desired, actual, diff } = jobPlan
  if (actual === undefined) throw new Error('updateMirrorJob called without actual state')
  const jobId = actual.job.id
  const realId = await reconcileSchedules(
    client,
    jobId,
    desired.name,
    desired.schedules,
    actual.schedules,
    mirrorScheduleSettings,
    record
  )

  const settings = mergeSettings(actual.job.settings, realId.deleted)
  settings[''] = { ...(settings[''] ?? {}), ...desired.settings }
  for (const [sched, id] of realId.byName) {
    const spec = desired.schedules.find(s => s.name === sched)
    if (spec) settings[id] = { ...(settings[id] ?? {}), ...mirrorScheduleSettings(spec) }
  }

  // mirrorBackup.editJob requires mode, sourceRemote and remotes every call
  const body: Record<string, unknown> = {
    id: jobId,
    mode: desired.mode,
    sourceRemote: sourceId,
    remotes: idPattern(targetIds),
    settings,
  }
  void diff
  await client.editMirrorBackupJob(body as Record<string, unknown> & { id: string })
}

// ---------------------------------------------------------------------------
// Sequences
// ---------------------------------------------------------------------------

async function applySequence(
  client: XoClient,
  seqPlan: SequencePlan,
  scheduleIndex: ScheduleIdIndex,
  kind: 'create' | 'update',
  log: (m: string) => void
): Promise<void> {
  const { desired } = seqPlan
  const scheduleIds = resolveSequenceSteps(desired, scheduleIndex)
  const paramsVector = buildParamsVector(scheduleIds)

  if (kind === 'create') {
    const createdJobId = await client.createCallJob({
      type: 'call',
      key: 'genericTask',
      method: SEQUENCE_METHOD,
      name: desired.name,
      paramsVector,
    })
    await client.createSchedule({
      jobId: createdJobId,
      cron: desired.cron,
      enabled: desired.enabled,
      name: '',
      ...(desired.timezone !== undefined ? { timezone: desired.timezone } : {}),
    } as Parameters<XoClient['createSchedule']>[0])
    log(`created sequence ${desired.name}`)
  } else {
    const actual = seqPlan.actual
    if (actual === undefined) throw new Error('update sequence without actual state')
    await client.setCallJob({ id: actual.job.id, name: desired.name, paramsVector })
    if (actual.schedule === undefined) {
      await client.createSchedule({
        jobId: actual.job.id,
        cron: desired.cron,
        enabled: desired.enabled,
        name: '',
        ...(desired.timezone !== undefined ? { timezone: desired.timezone } : {}),
      } as Parameters<XoClient['createSchedule']>[0])
    } else {
      await client.setSchedule({
        id: actual.schedule.id,
        cron: desired.cron,
        enabled: desired.enabled,
        ...(desired.timezone !== undefined ? { timezone: desired.timezone } : {}),
      })
    }
    log(`updated sequence ${desired.name}`)
  }
}

function resolveSequenceSteps(desired: DesiredSequence, scheduleIndex: ScheduleIdIndex): string[] {
  return desired.steps.map(step => {
    const id = scheduleIndex.get(scheduleIndexKey(step.job, step.schedule))
    if (id === undefined) {
      throw new Error(
        `sequence "${desired.name}": step references schedule "${step.schedule}" of job "${step.job}", ` +
          `which was not found in XO. Define that job (with that named schedule) in the file or in XO.`
      )
    }
    return id
  })
}

// ---------------------------------------------------------------------------
// Shared schedule reconciliation for metadata/mirror jobs
// ---------------------------------------------------------------------------

interface MinimalSchedule {
  name: string
  cron: string
  enabled: boolean
  timezone?: string
}

async function reconcileSchedules<T extends MinimalSchedule>(
  client: XoClient,
  jobId: string,
  jobName: string,
  desired: T[],
  actual: XoSchedule[],
  _settingsOf: (s: T) => Record<string, unknown>,
  record: (job: string, sched: string, id: string) => void
): Promise<{ byName: Map<string, string>; deleted: string[] }> {
  const generic = desired.map(s => ({ name: s.name, cron: s.cron, enabled: s.enabled, timezone: s.timezone, settings: {} }))
  const { pairs, unmatchedDesired, unmatchedActual } = matchSchedules(generic, actual)
  const byName = new Map<string, string>()
  const deleted: string[] = []

  for (const schedule of unmatchedActual) {
    await client.deleteSchedule(schedule.id)
    deleted.push(schedule.id)
  }
  for (const [d, a] of pairs) {
    const spec = desired.find(s => s.name === d.name)!
    const changed =
      spec.cron !== a.cron ||
      spec.enabled !== (a.enabled ?? false) ||
      (spec.name || undefined) !== (a.name || undefined) ||
      (spec.timezone !== undefined && spec.timezone !== a.timezone)
    if (changed) {
      await client.setSchedule({
        id: a.id,
        cron: spec.cron,
        enabled: spec.enabled,
        name: spec.name,
        ...(spec.timezone !== undefined ? { timezone: spec.timezone } : {}),
      })
    }
    byName.set(spec.name, a.id)
    record(jobName, spec.name, a.id)
  }
  for (const d of unmatchedDesired) {
    const spec = desired.find(s => s.name === d.name)!
    const created = await client.createSchedule({
      jobId,
      cron: spec.cron,
      enabled: spec.enabled,
      name: spec.name,
      ...(spec.timezone !== undefined ? { timezone: spec.timezone } : {}),
    } as Parameters<XoClient['createSchedule']>[0])
    byName.set(spec.name, created.id)
    record(jobName, spec.name, created.id)
  }
  return { byName, deleted }
}

function mergeSettings(
  actualSettings: Record<string, Record<string, unknown>> | undefined,
  deletedIds: string[]
): Record<string, Record<string, unknown>> {
  const settings: Record<string, Record<string, unknown>> = {}
  for (const [key, value] of Object.entries(actualSettings ?? {})) {
    if (!deletedIds.includes(key)) settings[key] = { ...value }
  }
  return settings
}

/**
 * After creating a job we don't know its new schedule ids. Re-list schedules
 * and record this job's named schedules into the sequence resolution index.
 */
async function indexJobSchedules(
  client: XoClient,
  jobName: string,
  record: (job: string, sched: string, id: string) => void
): Promise<void> {
  // Find the job id by name across all kinds, then map its schedules.
  const [jobs, meta, mirror, schedules] = await Promise.all([
    client.listBackupJobs(),
    client.listMetadataBackupJobs(),
    client.listMirrorBackupJobs(),
    client.listSchedules(),
  ])
  const match = [...jobs, ...meta, ...mirror].find(j => j.name === jobName)
  if (match === undefined) return
  for (const s of schedules) {
    if (s.jobId === match.id && s.name) record(jobName, s.name, s.id)
  }
}

// keep unused schedule-type imports referenced for downstream typing
export type { DesiredMetadataSchedule, DesiredMirrorSchedule, DesiredJob, DesiredMetadataJob, DesiredMirrorJob }

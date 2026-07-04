import type { XoClient, XoSchedule } from '../client/index.js'
import { matchSchedules, type DesiredJob, type DesiredSchedule } from '../resources/backup-jobs.js'
import { idPattern } from '../resources/patterns.js'
import type { ActualState, JobPlan, Plan } from './plan.js'

export async function fetchActualState(client: XoClient): Promise<ActualState> {
  const [remotes, jobs, schedules, vms] = await Promise.all([
    client.listRemotes(),
    client.listBackupJobs(),
    client.listSchedules(),
    client.listVms(),
  ])
  return { remotes, jobs, schedules, vms }
}

export interface ApplyOptions {
  prune?: boolean
  log?: (message: string) => void
}

function scheduleCreateBody(desired: DesiredSchedule): Record<string, unknown> {
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

  // -- 2. backup jobs ---------------------------------------------------------

  const resolveRemoteIds = (job: DesiredJob): string[] =>
    job.remoteNames.map(name => {
      const id = remoteIdByName.get(name)
      if (id === undefined) {
        throw new Error(`backup job "${job.name}": remote "${name}" not found in XO after apply`)
      }
      return id
    })

  for (const jobPlan of plan.jobs) {
    if (jobPlan.kind === 'create') {
      await createJob(client, jobPlan, resolveRemoteIds(jobPlan.desired))
      log(`created backup job ${jobPlan.desired.name}`)
    } else if (jobPlan.kind === 'update') {
      await updateJob(client, jobPlan, resolveRemoteIds(jobPlan.desired))
      log(`updated backup job ${jobPlan.desired.name}`)
    }
  }

  // -- 3. prune (untracked jobs first: they may reference untracked remotes) --

  if (prune) {
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

async function createJob(client: XoClient, jobPlan: JobPlan, remoteIds: string[]): Promise<void> {
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
    remotes: idPattern(remoteIds),
    settings,
    schedules,
  })
}

async function updateJob(client: XoClient, jobPlan: JobPlan, remoteIds: string[]): Promise<void> {
  const { desired, actual, diff } = jobPlan
  if (actual === undefined) {
    throw new Error('updateJob called without actual state')
  }
  const jobId = actual.job.id

  // reconcile schedules first so their real ids exist for the settings map
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
  }
  for (const desiredSchedule of unmatchedDesired) {
    const created: XoSchedule = await client.createSchedule({
      jobId,
      ...scheduleCreateBody(desiredSchedule),
    } as Parameters<XoClient['createSchedule']>[0])
    realScheduleId.set(desiredSchedule, created.id)
  }

  // merged settings: keep unmanaged keys, overlay what the file specifies
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
    }
    // settings.* changes are covered by the merged settings object above
  }

  await client.editBackupJob(body as Record<string, unknown> & { id: string })
}

import type { SequenceSpec } from '../config/schema.js'
import type { XoCallJob, XoSchedule } from '../client/index.js'
import { deepEqual } from './patterns.js'
import type { FieldChange } from './remotes.js'

export const SEQUENCE_METHOD = 'schedule.runSequence'

export interface DesiredSequence {
  name: string
  /** ordered (jobName, scheduleName) references, resolved to schedule ids at apply time */
  steps: Array<{ job: string; schedule: string }>
  cron: string
  enabled: boolean
  timezone?: string
}

export function sequenceSpecToDesired(spec: SequenceSpec): DesiredSequence {
  return {
    name: spec.name,
    steps: spec.steps.map(s => ({ job: s.job, schedule: s.schedule })),
    cron: spec.cron,
    enabled: spec.enabled,
    timezone: spec.timezone,
  }
}

/** A call-job is a sequence iff it runs schedule.runSequence. */
export function isSequenceJob(job: XoCallJob): boolean {
  return job.type === 'call' && job.method === SEQUENCE_METHOD
}

/** Pull the ordered schedule-id list out of a sequence job's paramsVector. */
export function extractSequenceScheduleIds(job: XoCallJob): string[] {
  const items = (job.paramsVector as { items?: unknown[] } | undefined)?.items
  if (!Array.isArray(items) || items.length === 0) {
    return []
  }
  const values = (items[0] as { values?: unknown[] } | undefined)?.values
  if (!Array.isArray(values) || values.length === 0) {
    return []
  }
  const schedules = (values[0] as { schedules?: unknown } | undefined)?.schedules
  return Array.isArray(schedules) ? (schedules.filter(s => typeof s === 'string') as string[]) : []
}

/** Build the paramsVector XO expects for a schedule.runSequence job. */
export function buildParamsVector(scheduleIds: string[]): Record<string, unknown> {
  return {
    type: 'crossProduct',
    items: [{ type: 'set', values: [{ schedules: scheduleIds }] }],
  }
}

// ---------------------------------------------------------------------------
// Diffing
// ---------------------------------------------------------------------------

export interface ActualSequence {
  job: XoCallJob
  /** the schedule that triggers this sequence job (schedule.jobId === job.id) */
  schedule?: XoSchedule
}

export interface SequenceDiff {
  changes: FieldChange[]
}

/**
 * Diff a desired sequence against its actual call-job + trigger schedule.
 * `resolvedScheduleIds` is the desired ordered schedule-id list, already
 * resolved from (job, schedule) names to real XO ids. When a referenced
 * schedule can't be resolved yet (its job is being created in the same run)
 * pass undefined to skip the ordering comparison — apply will set it.
 */
export function diffSequence(
  desired: DesiredSequence,
  actual: ActualSequence,
  resolvedScheduleIds: string[] | undefined
): SequenceDiff {
  const changes: FieldChange[] = []

  if (resolvedScheduleIds !== undefined) {
    const actualIds = extractSequenceScheduleIds(actual.job)
    // order matters for sequences, so compare the arrays directly
    if (!deepEqual(resolvedScheduleIds, actualIds)) {
      changes.push({ field: 'steps', from: actualIds, to: resolvedScheduleIds })
    }
  }

  const sched = actual.schedule
  if (sched === undefined) {
    changes.push({ field: 'schedule', from: '(missing)', to: `${desired.cron}` })
  } else {
    if (desired.cron !== sched.cron) {
      changes.push({ field: 'cron', from: sched.cron, to: desired.cron })
    }
    if (desired.enabled !== (sched.enabled ?? false)) {
      changes.push({ field: 'enabled', from: sched.enabled ?? false, to: desired.enabled })
    }
    if (desired.timezone !== undefined && desired.timezone !== sched.timezone) {
      changes.push({ field: 'timezone', from: sched.timezone, to: desired.timezone })
    }
  }

  return changes.length > 0 ? { changes } : { changes: [] }
}

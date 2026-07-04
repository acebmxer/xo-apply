import { describe, expect, it } from 'vitest'
import {
  backupJobSpecSchema,
  metadataBackupSpecSchema,
  mirrorBackupSpecSchema,
  sequenceSpecSchema,
} from '../src/config/schema.js'
import { diffMetadataJob, metadataSpecToDesired } from '../src/resources/metadata-backups.js'
import { diffMirrorJob, mirrorSpecToDesired } from '../src/resources/mirror-backups.js'
import {
  buildParamsVector,
  diffSequence,
  extractSequenceScheduleIds,
  isSequenceJob,
  sequenceSpecToDesired,
} from '../src/resources/sequences.js'
import { idPattern } from '../src/resources/patterns.js'
import type { XoCallJob, XoMetadataBackupJob, XoMirrorBackupJob } from '../src/client/index.js'

const mapping = { remoteNameById: new Map([['r1', 'nas']]), pendingRemoteNames: new Set<string>() }

describe('backup job SR targets (DR/CR)', () => {
  it('accepts an SR-only replication job', () => {
    const spec = backupJobSpecSchema.parse({ name: 'dr', mode: 'full', vms: { tag: 't' }, srs: ['sr-1'] })
    expect(spec.srs).toEqual(['sr-1'])
  })
  it('rejects a job with no remote and no SR', () => {
    expect(() => backupJobSpecSchema.parse({ name: 'x', mode: 'full', vms: { tag: 't' } })).toThrow(/at least one/)
  })
})

describe('metadata backups', () => {
  const spec = metadataBackupSpecSchema.parse({
    name: 'XO Backup',
    xoMetadata: true,
    remotes: ['nas'],
    schedules: [{ name: 'daily', cron: '0 21 * * *', xoRetention: 1, poolRetention: 1 }],
  })

  it('requires xoMetadata or pools', () => {
    expect(() => metadataBackupSpecSchema.parse({ name: 'z', remotes: ['nas'] })).toThrow(/xoMetadata/)
  })

  it('reports in sync when actual matches', () => {
    const actual: { job: XoMetadataBackupJob; schedules: any[] } = {
      job: {
        id: 'j1',
        name: 'XO Backup',
        type: 'metadataBackup',
        xoMetadata: true,
        remotes: idPattern(['r1']),
        settings: { '': {}, s1: { retentionXoMetadata: 1, retentionPoolMetadata: 1 } },
      },
      schedules: [{ id: 's1', jobId: 'j1', cron: '0 21 * * *', enabled: true, name: 'daily' }],
    }
    const diff = diffMetadataJob(metadataSpecToDesired(spec), actual, mapping)
    expect(diff.changes).toEqual([])
    expect(diff.scheduleChanges).toEqual([])
  })

  it('detects an xoRetention change', () => {
    const actual: { job: XoMetadataBackupJob; schedules: any[] } = {
      job: {
        id: 'j1',
        name: 'XO Backup',
        type: 'metadataBackup',
        xoMetadata: true,
        remotes: idPattern(['r1']),
        settings: { '': {}, s1: { retentionXoMetadata: 5, retentionPoolMetadata: 1 } },
      },
      schedules: [{ id: 's1', jobId: 'j1', cron: '0 21 * * *', enabled: true, name: 'daily' }],
    }
    const diff = diffMetadataJob(metadataSpecToDesired(spec), actual, mapping)
    expect(diff.scheduleChanges).toHaveLength(1)
  })
})

describe('mirror backups', () => {
  const spec = mirrorBackupSpecSchema.parse({
    name: 'Offsite',
    mode: 'full',
    sourceRemote: 'nas',
    remotes: ['nas'],
    schedules: [{ name: 'weekly', cron: '0 3 * * 0', retention: 4 }],
  })

  it('detects a mode change', () => {
    const actual: { job: XoMirrorBackupJob; schedules: any[] } = {
      job: {
        id: 'm1',
        name: 'Offsite',
        type: 'mirrorBackup',
        mode: 'delta',
        sourceRemote: 'r1',
        remotes: idPattern(['r1']),
        settings: { '': {} },
      },
      schedules: [{ id: 's1', jobId: 'm1', cron: '0 3 * * 0', enabled: true, name: 'weekly' }],
    }
    const diff = diffMirrorJob(mirrorSpecToDesired(spec), actual, mapping)
    expect(diff.changes.map(c => c.field)).toContain('mode')
  })
})

describe('sequences', () => {
  const seqJob: XoCallJob = {
    id: 'seq-1',
    name: 'Daily Backups',
    type: 'call',
    method: 'schedule.runSequence',
    paramsVector: buildParamsVector(['sched-a', 'sched-b']),
  }

  it('recognises a sequence call-job', () => {
    expect(isSequenceJob(seqJob)).toBe(true)
    expect(isSequenceJob({ ...seqJob, method: 'other' })).toBe(false)
  })

  it('extracts ordered schedule ids', () => {
    expect(extractSequenceScheduleIds(seqJob)).toEqual(['sched-a', 'sched-b'])
  })

  it('detects a reordering as a change', () => {
    const desired = sequenceSpecToDesired(
      sequenceSpecSchema.parse({
        name: 'Daily Backups',
        cron: '0 22 * * *',
        steps: [
          { job: 'A', schedule: 'x' },
          { job: 'B', schedule: 'y' },
        ],
      })
    )
    // resolved order reversed vs actual → change
    const diff = diffSequence(
      desired,
      { job: seqJob, schedule: { id: 't', jobId: 'seq-1', cron: '0 22 * * *', enabled: true, name: '' } },
      ['sched-b', 'sched-a']
    )
    expect(diff.changes.map(c => c.field)).toContain('steps')
  })

  it('is in sync when resolved ids and trigger match the actual job', () => {
    const desired = sequenceSpecToDesired(
      sequenceSpecSchema.parse({
        name: 'Daily Backups',
        cron: '0 22 * * *',
        steps: [
          { job: 'A', schedule: 'x' },
          { job: 'B', schedule: 'y' },
        ],
      })
    )
    const diff = diffSequence(
      desired,
      { job: seqJob, schedule: { id: 't', jobId: 'seq-1', cron: '0 22 * * *', enabled: true, name: '' } },
      ['sched-a', 'sched-b']
    )
    expect(diff.changes).toEqual([])
  })
})

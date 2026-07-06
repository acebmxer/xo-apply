import { describe, expect, it, vi } from 'vitest'
import { applyPlan } from '../src/engine/apply.js'
import { buildParamsVector } from '../src/resources/sequences.js'
import type { Plan } from '../src/engine/plan.js'
import type { XoClient } from '../src/client/index.js'

function emptyPlan(overrides: Partial<Plan>): Plan {
  return {
    remotesManaged: false,
    jobsManaged: false,
    metadataManaged: false,
    mirrorManaged: false,
    sequencesManaged: true,
    remotes: [],
    jobs: [],
    metadataJobs: [],
    mirrorJobs: [],
    sequences: [],
    usersManaged: false,
    groupsManaged: false,
    users: [],
    groups: [],
    untrackedRemotes: [],
    untrackedJobs: [],
    untrackedMetadataJobs: [],
    untrackedMirrorJobs: [],
    untrackedSequences: [],
    untrackedUsers: [],
    untrackedGroups: [],
    externalUserCount: 0,
    externalGroupCount: 0,
    ...overrides,
  }
}

describe('applyPlan — sequence creation', () => {
  it('passes the job id returned by createCallJob (a string) to createSchedule', async () => {
    // job.create returns the id as a bare string, not { id }
    const createCallJob = vi.fn(async (_params: Record<string, unknown>) => 'new-seq-job-id')
    const createSchedule = vi.fn(async (_params: Record<string, unknown>) => ({
      id: 'sched-x',
      jobId: 'new-seq-job-id',
      cron: '',
      name: '',
    }))
    const client = { createCallJob, createSchedule } as unknown as XoClient

    const plan = emptyPlan({
      sequences: [
        {
          kind: 'create',
          desired: {
            name: 'Daily Backups',
            steps: [{ job: 'Delta Backup', schedule: 'Delta Backups' }],
            cron: '0 22 * * *',
            enabled: true,
          },
          diff: { changes: [] },
        },
      ],
    })

    // A zero-step sequence keeps this unit focused on the create wiring:
    // resolveSequenceSteps reads an (empty) live index, so any real step would
    // fail to resolve. What we're pinning down is that the job id flows into
    // createSchedule as a string, not `undefined`.
    plan.sequences[0].desired.steps = []

    await applyPlan(client, plan)

    expect(createCallJob).toHaveBeenCalledOnce()
    expect(createSchedule).toHaveBeenCalledOnce()
    const scheduleArg = createSchedule.mock.calls[0][0]
    expect(scheduleArg.jobId).toBe('new-seq-job-id')
    // sanity: paramsVector shape is what XO expects
    const jobArg = createCallJob.mock.calls[0][0]
    expect(jobArg.paramsVector).toEqual(buildParamsVector([]))
  })
})

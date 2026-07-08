import { describe, expect, it } from 'vitest'
import { groupSpecSchema, userSpecSchema, validateSpec } from '../src/config/schema.js'
import {
  diffUser,
  envVarNameForUser,
  isLocalUser,
  userSpecToDesired,
  userToSpec,
} from '../src/resources/users.js'
import { diffGroup, groupSpecToDesired, groupToSpec, isLocalGroup } from '../src/resources/groups.js'
import { buildPlan, planHasChanges, type ActualState } from '../src/engine/plan.js'
import type { XoGroup, XoUser } from '../src/client/index.js'

const emptyXo: ActualState = {
  remotes: [],
  jobs: [],
  metadataJobs: [],
  mirrorJobs: [],
  callJobs: [],
  schedules: [],
  vms: [],
  users: [],
  groups: [],
  servers: [],
}

describe('user/group schema', () => {
  it('parses a valid user and defaults permission to undefined', () => {
    const u = userSpecSchema.parse({ email: 'a@x.com', password: 'secret' })
    expect(u.email).toBe('a@x.com')
    expect(u.permission).toBeUndefined()
  })

  it('rejects an unknown permission', () => {
    expect(() => userSpecSchema.parse({ email: 'a@x.com', permission: 'superuser' })).toThrow()
  })

  it('defaults group users to an empty array', () => {
    const g = groupSpecSchema.parse({ name: 'ops' })
    expect(g.users).toEqual([])
  })

  it('detects duplicate user emails', () => {
    expect(() =>
      validateSpec({ users: [{ email: 'a@x.com' }, { email: 'a@x.com' }] })
    ).toThrow(/duplicate user email/)
  })

  it('detects duplicate group names and duplicate members', () => {
    expect(() => validateSpec({ groups: [{ name: 'ops' }, { name: 'ops' }] })).toThrow(/duplicate group name/)
    expect(() =>
      validateSpec({ groups: [{ name: 'ops', users: ['a@x.com', 'a@x.com'] }] })
    ).toThrow(/duplicate member/)
  })
})

describe('userSpecToDesired', () => {
  it('defaults permission to none and carries the password through', () => {
    const d = userSpecToDesired(userSpecSchema.parse({ email: 'a@x.com', password: 'p' }))
    expect(d).toEqual({ email: 'a@x.com', permission: 'none', password: 'p' })
  })
})

describe('isLocalUser / isLocalGroup', () => {
  it('classifies users by authProviders', () => {
    expect(isLocalUser({ id: '1', email: 'a@x.com' })).toBe(true)
    expect(isLocalUser({ id: '1', email: 'a@x.com', authProviders: {} })).toBe(true)
    expect(isLocalUser({ id: '1', email: 'a@x.com', authProviders: { ldap: {} } })).toBe(false)
  })

  it('classifies groups by provider marker', () => {
    expect(isLocalGroup({ id: '1', name: 'ops' })).toBe(true)
    expect(isLocalGroup({ id: '1', name: 'ops', provider: 'ldap' })).toBe(false)
  })
})

describe('diffUser', () => {
  const desired = userSpecToDesired(userSpecSchema.parse({ email: 'a@x.com', password: 'p', permission: 'admin' }))

  it('reports a permission change', () => {
    const actual: XoUser = { id: '1', email: 'a@x.com', permission: 'read' }
    expect(diffUser(desired, actual)).toEqual([{ field: 'permission', from: 'read', to: 'admin' }])
  })

  it('never diffs the password (in sync despite a password being set)', () => {
    const actual: XoUser = { id: '1', email: 'a@x.com', permission: 'admin' }
    expect(diffUser(desired, actual)).toEqual([])
  })

  it('treats a missing actual permission as none', () => {
    const d = userSpecToDesired(userSpecSchema.parse({ email: 'a@x.com', permission: 'none' }))
    expect(diffUser(d, { id: '1', email: 'a@x.com' })).toEqual([])
  })
})

describe('userToSpec', () => {
  it('exports email + permission with the ChangeMe placeholder password', () => {
    const { spec } = userToSpec({ id: '1', email: 'ops@example.com', permission: 'write' })
    expect(spec).toEqual({ email: 'ops@example.com', password: 'ChangeMe', permission: 'write' })
  })

  it('still derives a clean env var name (for opting into a ${env:...} ref)', () => {
    expect(envVarNameForUser('a.b+c@x.com')).toBe('XO_USER_A_B_C_X_COM_PASSWORD')
  })
})

describe('groupToSpec / diffGroup', () => {
  const userEmailById = new Map([
    ['u1', 'a@x.com'],
    ['u2', 'b@x.com'],
  ])

  it('maps member ids to emails on export', () => {
    const g: XoGroup = { id: 'g1', name: 'ops', users: ['u1', 'u2'] }
    expect(groupToSpec(g, userEmailById)).toEqual({ name: 'ops', users: ['a@x.com', 'b@x.com'] })
  })

  it('falls back to the raw id for an unknown member', () => {
    const g: XoGroup = { id: 'g1', name: 'ops', users: ['u1', 'ghost'] }
    expect(groupToSpec(g, userEmailById)).toEqual({ name: 'ops', users: ['a@x.com', 'ghost'] })
  })

  it('compares membership order-insensitively', () => {
    const desired = groupSpecToDesired(groupSpecSchema.parse({ name: 'ops', users: ['b@x.com', 'a@x.com'] }))
    const actual: XoGroup = { id: 'g1', name: 'ops', users: ['u1', 'u2'] }
    expect(diffGroup(desired, actual, userEmailById)).toEqual([])
  })

  it('reports a membership change', () => {
    const desired = groupSpecToDesired(groupSpecSchema.parse({ name: 'ops', users: ['a@x.com'] }))
    const actual: XoGroup = { id: 'g1', name: 'ops', users: ['u1', 'u2'] }
    expect(diffGroup(desired, actual, userEmailById)).toEqual([
      { field: 'users', from: ['a@x.com', 'b@x.com'], to: ['a@x.com'] },
    ])
  })
})

describe('buildPlan: users & groups', () => {
  it('plans create for a user and a group referencing it', () => {
    const spec = validateSpec({
      users: [{ email: 'a@x.com', password: 'p', permission: 'admin' }],
      groups: [{ name: 'ops', users: ['a@x.com'] }],
    })
    const plan = buildPlan(spec, emptyXo)
    expect(plan.users.map(u => u.kind)).toEqual(['create'])
    expect(plan.groups.map(g => g.kind)).toEqual(['create'])
    expect(planHasChanges(plan)).toBe(true)
  })

  it('classifies external users as neither managed nor untracked', () => {
    const actual: ActualState = {
      ...emptyXo,
      users: [
        { id: 'ext', email: 'sso@x.com', authProviders: { saml: {} } },
        { id: 'loc', email: 'old@x.com' },
      ],
    }
    // manage users, but the file lists none of the existing ones
    const plan = buildPlan(validateSpec({ users: [] }), actual)
    expect(plan.externalUserCount).toBe(1)
    // only the local user is untracked; the SSO user is never a prune candidate
    expect(plan.untrackedUsers.map(u => u.email)).toEqual(['old@x.com'])
  })

  it('lets a group member reference an existing XO user', () => {
    const actual: ActualState = { ...emptyXo, users: [{ id: 'u1', email: 'a@x.com' }] }
    const plan = buildPlan(validateSpec({ groups: [{ name: 'ops', users: ['a@x.com'] }] }), actual)
    expect(plan.groups[0].kind).toBe('create')
  })

  it('throws when a group references an unknown user', () => {
    expect(() =>
      buildPlan(validateSpec({ groups: [{ name: 'ops', users: ['ghost@x.com'] }] }), emptyXo)
    ).toThrow(/references user "ghost@x.com"/)
  })

  it('does not manage users/groups when the sections are absent', () => {
    const actual: ActualState = {
      ...emptyXo,
      users: [{ id: 'u1', email: 'a@x.com' }],
      groups: [{ id: 'g1', name: 'ops' }],
    }
    const plan = buildPlan(validateSpec({}), actual)
    expect(plan.usersManaged).toBe(false)
    expect(plan.groupsManaged).toBe(false)
    expect(plan.untrackedUsers).toEqual([])
    expect(plan.untrackedGroups).toEqual([])
  })
})

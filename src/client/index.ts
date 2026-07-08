import { JsonRpcClient } from './jsonrpc.js'
import { RestClient } from './rest.js'

/**
 * XO rejects server.enable/disable with an "incorrect state" error when the
 * pool is already in (or moving toward) the requested connection state — e.g.
 * a version that auto-connects on server.add leaves it "connecting", not
 * "disconnected". That is not a real failure for us, so callers can ignore it.
 */
function isIncorrectStateError(error: unknown): boolean {
  return error instanceof Error && /incorrect state/i.test(error.message)
}

// -- XO object shapes (the subset this tool reads/writes) -------------------

export interface XoRemote {
  id: string
  name: string
  url: string
  options?: string | null
  proxy?: string | null
  enabled?: boolean
}

export interface XoBackupJob {
  id: string
  name: string
  type: 'backup'
  mode: 'full' | 'delta'
  compression?: '' | 'native' | 'zstd'
  vms: Record<string, unknown>
  remotes?: Record<string, unknown>
  srs?: Record<string, unknown>
  settings: Record<string, Record<string, unknown>>
  proxy?: string
}

export interface XoMetadataBackupJob {
  id: string
  name: string
  type: 'metadataBackup'
  pools?: Record<string, unknown>
  remotes?: Record<string, unknown>
  xoMetadata?: boolean
  poolMetadata?: boolean
  settings: Record<string, Record<string, unknown>>
  proxy?: string
}

export interface XoMirrorBackupJob {
  id: string
  name: string
  type: 'mirrorBackup'
  mode: 'full' | 'delta'
  /** id of the source remote whose backups are mirrored */
  sourceRemote?: string
  /** destination remotes (id pattern) */
  remotes?: Record<string, unknown>
  settings: Record<string, Record<string, unknown>>
  proxy?: string
}

/**
 * A "sequence" as shown in the XO UI is a generic call-job that runs a list of
 * schedules in order. It lives in the `job` namespace (NOT backupNg), so it must
 * be read via job.getAll and written via job.create/set/delete.
 */
export interface XoCallJob {
  id: string
  name: string
  type: 'call'
  key?: string
  method: string
  paramsVector?: Record<string, unknown>
  userId?: string
}

export interface XoSchedule {
  id: string
  jobId: string
  cron: string
  enabled?: boolean
  name?: string
  timezone?: string
}

export interface XoVm {
  id: string
  name_label: string
  tags?: string[]
}

export interface XoUser {
  id: string
  /** the login / identity of the user */
  email: string
  permission?: 'none' | 'read' | 'write' | 'admin'
  /** group ids this user belongs to */
  groups?: string[]
  /**
   * Present (and non-empty) only for users provisioned by an external auth
   * plugin (LDAP/SAML/GitHub…). Local users have no external provider entry.
   * XO returns this as an object keyed by provider id.
   */
  authProviders?: Record<string, unknown>
}

export interface XoGroup {
  id: string
  name: string
  /** member user ids */
  users?: string[]
  /** set for groups synchronized from an external auth provider */
  provider?: string
  providerGroupId?: string
}

export interface XoServer {
  id: string
  /** the pool master address this connection points at (identity key) */
  host: string
  username: string
  label?: string
  /** accept self-signed / otherwise-invalid TLS certs from the pool */
  allowUnauthorized?: boolean
  /** whether XO keeps this pool connected; toggled via enable/disable */
  enabled?: boolean
  readOnly?: boolean
  status?: string
  poolId?: string
}

export interface XoClientOptions {
  url: string
  token: string
  insecure?: boolean
}

/**
 * Facade over XO's two APIs. Callers never know which API serves a request:
 * - REST /rest/v0 wherever it supports the operation (remotes CRU, VM listing)
 * - JSON-RPC (xo-lib) where REST is still read-only (backup jobs, schedules)
 *   or missing the operation (remote deletion — REST only has "forget").
 * When the REST API reaches parity, only this file changes.
 */
export class XoClient {
  readonly #rest: RestClient
  readonly #rpc: JsonRpcClient

  constructor(opts: XoClientOptions) {
    this.#rest = new RestClient(opts)
    this.#rpc = new JsonRpcClient(opts)
  }

  // -- remotes (backup repositories) ----------------------------------------

  listRemotes(): Promise<XoRemote[]> {
    return this.#rest.get('/backup-repositories', { fields: 'id,name,url,options,proxy,enabled' })
  }

  async createRemote(body: { name: string; url: string; options?: string; proxy?: string }): Promise<{ id: string }> {
    return this.#rest.post('/backup-repositories', body)
  }

  async updateRemote(
    id: string,
    body: { name?: string; url?: string; options?: string | null; proxy?: string | null }
  ): Promise<void> {
    await this.#rest.patch(`/backup-repositories/${id}`, body)
  }

  async deleteRemote(id: string): Promise<void> {
    await this.#rpc.call('remote.delete', { id })
  }

  // -- backup jobs (VM backups) ----------------------------------------------

  listBackupJobs(): Promise<XoBackupJob[]> {
    return this.#rpc.call('backupNg.getAllJobs')
  }

  createBackupJob(params: Record<string, unknown>): Promise<string> {
    return this.#rpc.call('backupNg.createJob', params)
  }

  async editBackupJob(params: Record<string, unknown> & { id: string }): Promise<void> {
    await this.#rpc.call('backupNg.editJob', params)
  }

  async deleteBackupJob(id: string): Promise<void> {
    await this.#rpc.call('backupNg.deleteJob', { id })
  }

  // -- metadata backup jobs (pool / XO config metadata) ----------------------

  listMetadataBackupJobs(): Promise<XoMetadataBackupJob[]> {
    return this.#rpc.call('metadataBackup.getAllJobs')
  }

  createMetadataBackupJob(params: Record<string, unknown>): Promise<string> {
    return this.#rpc.call('metadataBackup.createJob', params)
  }

  async editMetadataBackupJob(params: Record<string, unknown> & { id: string }): Promise<void> {
    await this.#rpc.call('metadataBackup.editJob', params)
  }

  async deleteMetadataBackupJob(id: string): Promise<void> {
    await this.#rpc.call('metadataBackup.deleteJob', { id })
  }

  // -- mirror backup jobs (replicate one remote's backups to another) --------

  listMirrorBackupJobs(): Promise<XoMirrorBackupJob[]> {
    return this.#rpc.call('mirrorBackup.getAllJobs')
  }

  createMirrorBackupJob(params: Record<string, unknown>): Promise<string> {
    return this.#rpc.call('mirrorBackup.createJob', params)
  }

  async editMirrorBackupJob(params: Record<string, unknown> & { id: string }): Promise<void> {
    await this.#rpc.call('mirrorBackup.editJob', params)
  }

  async deleteMirrorBackupJob(id: string): Promise<void> {
    await this.#rpc.call('mirrorBackup.deleteJob', { id })
  }

  // -- sequences (generic call-jobs running schedule.runSequence) ------------

  /** All generic jobs; sequences are those with method "schedule.runSequence". */
  listCallJobs(): Promise<XoCallJob[]> {
    return this.#rpc.call('job.getAll')
  }

  /** job.create returns the new job's id as a plain string. */
  createCallJob(params: Record<string, unknown>): Promise<string> {
    return this.#rpc.call('job.create', { job: params })
  }

  async setCallJob(params: Record<string, unknown> & { id: string }): Promise<void> {
    await this.#rpc.call('job.set', { job: params })
  }

  async deleteCallJob(id: string): Promise<void> {
    await this.#rpc.call('job.delete', { id })
  }

  // -- schedules ---------------------------------------------------------------

  listSchedules(): Promise<XoSchedule[]> {
    return this.#rpc.call('schedule.getAll')
  }

  createSchedule(params: {
    jobId: string
    cron: string
    enabled?: boolean
    name?: string
    timezone?: string
  }): Promise<XoSchedule> {
    return this.#rpc.call('schedule.create', params)
  }

  async setSchedule(params: {
    id: string
    cron?: string
    enabled?: boolean
    name?: string
    timezone?: string
  }): Promise<void> {
    await this.#rpc.call('schedule.set', params)
  }

  async deleteSchedule(id: string): Promise<void> {
    await this.#rpc.call('schedule.delete', { id })
  }

  // -- VMs (read-only, for name → uuid resolution) ---------------------------

  listVms(): Promise<XoVm[]> {
    return this.#rest.get('/vms', { fields: 'id,name_label,tags' })
  }

  // -- users (local auth) ----------------------------------------------------

  listUsers(): Promise<XoUser[]> {
    return this.#rest.get('/users', { fields: 'id,email,permission,groups,authProviders' })
  }

  /** user.create returns the new user's id as a plain string. */
  createUser(params: { email: string; password?: string; permission?: string }): Promise<string> {
    return this.#rpc.call('user.create', params)
  }

  async setUser(params: { id: string; email?: string; password?: string; permission?: string }): Promise<void> {
    await this.#rpc.call('user.set', params)
  }

  async deleteUser(id: string): Promise<void> {
    await this.#rpc.call('user.delete', { id })
  }

  // -- groups ----------------------------------------------------------------

  listGroups(): Promise<XoGroup[]> {
    return this.#rest.get('/groups', { fields: 'id,name,users,provider,providerGroupId' })
  }

  /** group.create returns the new group object (with its id). */
  createGroup(params: { name: string }): Promise<XoGroup> {
    return this.#rpc.call('group.create', params)
  }

  /** Set a group's members to exactly this list of user ids. */
  async setGroupUsers(id: string, userIds: string[]): Promise<void> {
    await this.#rpc.call('group.setUsers', { id, userIds })
  }

  async deleteGroup(id: string): Promise<void> {
    await this.#rpc.call('group.delete', { id })
  }

  // -- servers (pool connections) --------------------------------------------

  listServers(): Promise<XoServer[]> {
    return this.#rest.get('/servers', {
      fields: 'id,host,username,label,allowUnauthorized,enabled,readOnly,status,poolId',
    })
  }

  /** server.add returns the new server's id as a plain string. */
  createServer(params: {
    host: string
    username: string
    password: string
    label?: string
    allowUnauthorized?: boolean
  }): Promise<string> {
    return this.#rpc.call('server.add', params)
  }

  /** Password is deliberately omitted here — updates never clobber it. */
  async setServer(params: {
    id: string
    host?: string
    username?: string
    label?: string
    allowUnauthorized?: boolean
  }): Promise<void> {
    await this.#rpc.call('server.set', params)
  }

  /**
   * Connect the pool. Idempotent: some XO versions auto-connect on `server.add`,
   * so the server may already be connecting/connected — XO then rejects enable
   * with an "incorrect state" error, which we treat as success.
   */
  async enableServer(id: string): Promise<void> {
    try {
      await this.#rpc.call('server.enable', { id })
    } catch (error) {
      if (!isIncorrectStateError(error)) throw error
    }
  }

  /** Disconnect the pool. Idempotent (already-disconnected is not an error). */
  async disableServer(id: string): Promise<void> {
    try {
      await this.#rpc.call('server.disable', { id })
    } catch (error) {
      if (!isIncorrectStateError(error)) throw error
    }
  }

  async removeServer(id: string): Promise<void> {
    await this.#rpc.call('server.remove', { id })
  }

  close(): void {
    this.#rpc.close()
  }
}

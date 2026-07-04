import { JsonRpcClient } from './jsonrpc.js'
import { RestClient } from './rest.js'

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

  close(): void {
    this.#rpc.close()
  }
}

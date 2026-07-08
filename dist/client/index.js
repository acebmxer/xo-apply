import { JsonRpcClient } from './jsonrpc.js';
import { RestClient } from './rest.js';
/**
 * XO rejects server.enable/disable with an "incorrect state" error when the
 * pool is already in (or moving toward) the requested connection state — e.g.
 * a version that auto-connects on server.add leaves it "connecting", not
 * "disconnected". That is not a real failure for us, so callers can ignore it.
 */
function isIncorrectStateError(error) {
    return error instanceof Error && /incorrect state/i.test(error.message);
}
/**
 * Facade over XO's two APIs. Callers never know which API serves a request:
 * - REST /rest/v0 wherever it supports the operation (remotes CRU, VM listing)
 * - JSON-RPC (xo-lib) where REST is still read-only (backup jobs, schedules)
 *   or missing the operation (remote deletion — REST only has "forget").
 * When the REST API reaches parity, only this file changes.
 */
export class XoClient {
    #rest;
    #rpc;
    constructor(opts) {
        this.#rest = new RestClient(opts);
        this.#rpc = new JsonRpcClient(opts);
    }
    // -- remotes (backup repositories) ----------------------------------------
    listRemotes() {
        return this.#rest.get('/backup-repositories', { fields: 'id,name,url,options,proxy,enabled' });
    }
    async createRemote(body) {
        return this.#rest.post('/backup-repositories', body);
    }
    async updateRemote(id, body) {
        await this.#rest.patch(`/backup-repositories/${id}`, body);
    }
    async deleteRemote(id) {
        await this.#rpc.call('remote.delete', { id });
    }
    // -- backup jobs (VM backups) ----------------------------------------------
    listBackupJobs() {
        return this.#rpc.call('backupNg.getAllJobs');
    }
    createBackupJob(params) {
        return this.#rpc.call('backupNg.createJob', params);
    }
    async editBackupJob(params) {
        await this.#rpc.call('backupNg.editJob', params);
    }
    async deleteBackupJob(id) {
        await this.#rpc.call('backupNg.deleteJob', { id });
    }
    // -- metadata backup jobs (pool / XO config metadata) ----------------------
    listMetadataBackupJobs() {
        return this.#rpc.call('metadataBackup.getAllJobs');
    }
    createMetadataBackupJob(params) {
        return this.#rpc.call('metadataBackup.createJob', params);
    }
    async editMetadataBackupJob(params) {
        await this.#rpc.call('metadataBackup.editJob', params);
    }
    async deleteMetadataBackupJob(id) {
        await this.#rpc.call('metadataBackup.deleteJob', { id });
    }
    // -- mirror backup jobs (replicate one remote's backups to another) --------
    listMirrorBackupJobs() {
        return this.#rpc.call('mirrorBackup.getAllJobs');
    }
    createMirrorBackupJob(params) {
        return this.#rpc.call('mirrorBackup.createJob', params);
    }
    async editMirrorBackupJob(params) {
        await this.#rpc.call('mirrorBackup.editJob', params);
    }
    async deleteMirrorBackupJob(id) {
        await this.#rpc.call('mirrorBackup.deleteJob', { id });
    }
    // -- sequences (generic call-jobs running schedule.runSequence) ------------
    /** All generic jobs; sequences are those with method "schedule.runSequence". */
    listCallJobs() {
        return this.#rpc.call('job.getAll');
    }
    /** job.create returns the new job's id as a plain string. */
    createCallJob(params) {
        return this.#rpc.call('job.create', { job: params });
    }
    async setCallJob(params) {
        await this.#rpc.call('job.set', { job: params });
    }
    async deleteCallJob(id) {
        await this.#rpc.call('job.delete', { id });
    }
    // -- schedules ---------------------------------------------------------------
    listSchedules() {
        return this.#rpc.call('schedule.getAll');
    }
    createSchedule(params) {
        return this.#rpc.call('schedule.create', params);
    }
    async setSchedule(params) {
        await this.#rpc.call('schedule.set', params);
    }
    async deleteSchedule(id) {
        await this.#rpc.call('schedule.delete', { id });
    }
    // -- VMs (read-only, for name → uuid resolution) ---------------------------
    listVms() {
        return this.#rest.get('/vms', { fields: 'id,name_label,tags' });
    }
    // -- users (local auth) ----------------------------------------------------
    listUsers() {
        return this.#rest.get('/users', { fields: 'id,email,permission,groups,authProviders' });
    }
    /** user.create returns the new user's id as a plain string. */
    createUser(params) {
        return this.#rpc.call('user.create', params);
    }
    async setUser(params) {
        await this.#rpc.call('user.set', params);
    }
    async deleteUser(id) {
        await this.#rpc.call('user.delete', { id });
    }
    // -- groups ----------------------------------------------------------------
    listGroups() {
        return this.#rest.get('/groups', { fields: 'id,name,users,provider,providerGroupId' });
    }
    /** group.create returns the new group object (with its id). */
    createGroup(params) {
        return this.#rpc.call('group.create', params);
    }
    /** Set a group's members to exactly this list of user ids. */
    async setGroupUsers(id, userIds) {
        await this.#rpc.call('group.setUsers', { id, userIds });
    }
    async deleteGroup(id) {
        await this.#rpc.call('group.delete', { id });
    }
    // -- servers (pool connections) --------------------------------------------
    listServers() {
        return this.#rest.get('/servers', {
            fields: 'id,host,username,label,allowUnauthorized,enabled,readOnly,status,poolId',
        });
    }
    /** server.add returns the new server's id as a plain string. */
    createServer(params) {
        return this.#rpc.call('server.add', params);
    }
    /** Password is deliberately omitted here — updates never clobber it. */
    async setServer(params) {
        await this.#rpc.call('server.set', params);
    }
    /**
     * Connect the pool. Idempotent: some XO versions auto-connect on `server.add`,
     * so the server may already be connecting/connected — XO then rejects enable
     * with an "incorrect state" error, which we treat as success.
     */
    async enableServer(id) {
        try {
            await this.#rpc.call('server.enable', { id });
        }
        catch (error) {
            if (!isIncorrectStateError(error))
                throw error;
        }
    }
    /** Disconnect the pool. Idempotent (already-disconnected is not an error). */
    async disableServer(id) {
        try {
            await this.#rpc.call('server.disable', { id });
        }
        catch (error) {
            if (!isIncorrectStateError(error))
                throw error;
        }
    }
    async removeServer(id) {
        await this.#rpc.call('server.remove', { id });
    }
    close() {
        this.#rpc.close();
    }
}

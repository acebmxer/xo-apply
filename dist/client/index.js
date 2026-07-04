import { JsonRpcClient } from './jsonrpc.js';
import { RestClient } from './rest.js';
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
    close() {
        this.#rpc.close();
    }
}

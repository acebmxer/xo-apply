import { readdirSync, writeFileSync } from 'node:fs';
import { relative, resolve } from 'node:path';
import { cancel, confirm, intro, isCancel, log, note, outro, password, select, spinner, text, } from '@clack/prompts';
import pc from 'picocolors';
import { XoClient } from '../client/index.js';
import { loadSpec } from '../config/load.js';
import { applyPlan, fetchActualState } from '../engine/apply.js';
import { renderPlan } from '../engine/diff.js';
import { buildPlan, planHasChanges, planHasDrift } from '../engine/plan.js';
import { exportSpec } from '../export/export.js';
/** Thrown internally to unwind to the top-level handler on user cancel. */
class Cancelled extends Error {
}
/** Abort the wizard cleanly if the user hit Ctrl-C / Esc at a prompt. */
function unwrap(value) {
    if (isCancel(value)) {
        throw new Cancelled();
    }
    return value;
}
/** Prompt for connection details, prefilling from flags then XO_URL / XO_TOKEN. */
async function promptConnection(opts) {
    const envUrl = opts.url ?? process.env.XO_URL;
    const envToken = opts.token ?? process.env.XO_TOKEN;
    const url = unwrap(await text({
        message: 'XO base URL',
        placeholder: 'https://xo.example.lan',
        initialValue: envUrl ?? '',
        validate: value => (value.trim().length === 0 ? 'A URL is required.' : undefined),
    })).trim();
    // If a token is already in the environment, offer to reuse it silently.
    let token;
    if (envToken !== undefined && envToken.length > 0) {
        const reuse = unwrap(await confirm({ message: 'Use the token from $XO_TOKEN?', initialValue: true }));
        token = reuse
            ? envToken
            : unwrap(await password({
                message: 'XO authentication token',
                validate: value => (value.length === 0 ? 'A token is required.' : undefined),
            }));
    }
    else {
        token = unwrap(await password({
            message: 'XO authentication token',
            validate: value => (value.length === 0 ? 'A token is required.' : undefined),
        }));
    }
    const insecure = unwrap(await confirm({
        message: 'Skip TLS certificate verification? (self-signed certs)',
        initialValue: false,
    }));
    return { url, token, insecure };
}
/** Run a promise under a labelled spinner, restarting it on failure. */
async function withSpinner(message, fn) {
    const s = spinner();
    s.start(message);
    try {
        const result = await fn();
        s.stop(message);
        return result;
    }
    catch (error) {
        s.stop(pc.red(message), 1);
        throw error;
    }
}
/** Offer the YAML files in the working directory, plus a manual-path option. */
async function promptConfigPath() {
    let yamlFiles = [];
    try {
        yamlFiles = readdirSync(process.cwd())
            .filter(name => name.endsWith('.yaml') || name.endsWith('.yml'))
            .sort();
    }
    catch {
        // fall through to manual entry
    }
    if (yamlFiles.length > 0) {
        const options = [
            ...yamlFiles.map((name) => ({ value: name, label: name })),
            { value: '\0other', label: 'Enter a path manually…' },
        ];
        const choice = unwrap(await select({ message: 'Which config file?', options }));
        if (choice !== '\0other') {
            return resolve(process.cwd(), choice);
        }
    }
    const manual = unwrap(await text({
        message: 'Path to the YAML config file',
        placeholder: './xo-config.yaml',
        validate: value => (value.trim().length === 0 ? 'A path is required.' : undefined),
    })).trim();
    return resolve(process.cwd(), manual);
}
/** Print a rendered plan through clack's note box, preserving colors. */
function showPlan(plan, prune) {
    note(renderPlan(plan, { prune }), prune ? 'Plan (with prune)' : 'Plan');
}
/** diff / apply flow: pick a file, review the plan, optionally reconcile. */
async function runDiffApply(client, mode) {
    const configPath = await promptConfigPath();
    const spec = loadSpec(configPath);
    let prune = false;
    if (mode === 'apply') {
        prune = unwrap(await confirm({
            message: 'Also delete resources in XO that are not in the file? (prune)',
            initialValue: false,
        }));
    }
    const actual = await withSpinner('Reading XO state…', () => fetchActualState(client));
    const plan = buildPlan(spec, actual);
    showPlan(plan, prune);
    if (mode === 'diff') {
        if (planHasDrift(plan)) {
            log.warn('XO does not match the config file.');
        }
        else {
            log.success('In sync: XO matches the config file.');
        }
        return;
    }
    const hasWork = planHasChanges(plan) || (prune && (plan.untrackedRemotes.length > 0 || plan.untrackedJobs.length > 0));
    if (!hasWork) {
        log.success('Nothing to do: XO matches the config file.');
        return;
    }
    const proceed = unwrap(await confirm({ message: 'Apply these changes?', initialValue: false }));
    if (!proceed) {
        log.info('Aborted — no changes made.');
        return;
    }
    await withSpinner('Applying…', () => applyPlan(client, plan, { prune, log: message => log.step(message) }));
    log.success('Apply complete.');
}
/** export flow: read XO and write (or preview) a spec document. */
async function runExport(client) {
    const actual = await withSpinner('Reading XO state…', () => fetchActualState(client));
    const { yaml, warnings } = exportSpec(actual);
    for (const warning of warnings) {
        log.warn(warning);
    }
    // No validator here — an empty answer is allowed (preview-only). clack's
    // text() returns undefined for an empty submission, so normalize before trim.
    const answer = unwrap(await text({
        message: 'Write exported config to (leave blank to preview only)',
        placeholder: './xo-config.yaml',
    }));
    const destination = (answer ?? '').trim();
    if (destination.length === 0) {
        note(yaml, 'Exported config');
        return;
    }
    const outPath = resolve(process.cwd(), destination);
    writeFileSync(outPath, yaml);
    log.success(`Exported to ${relative(process.cwd(), outPath) || outPath}`);
}
/**
 * Interactive entry point launched when `xo-apply` runs with no subcommand.
 * A thin front-end over the same engine the CLI subcommands use.
 */
export async function runWizard(opts = {}) {
    if (!process.stdin.isTTY) {
        console.error(pc.red('error: the interactive UI needs a terminal.') +
            '\nRun a subcommand instead (e.g. `xo-apply diff <config>`); see `xo-apply --help`.');
        return 1;
    }
    intro(pc.inverse(' xo-apply '));
    let client;
    try {
        const connection = await promptConnection(opts);
        if (connection.insecure) {
            process.env.NODE_TLS_REJECT_UNAUTHORIZED = '0';
        }
        client = new XoClient(connection);
        // Loop so the user can run several actions on one connection.
        for (;;) {
            const actionOptions = [
                { value: 'diff', label: 'Diff — compare a config file against XO' },
                { value: 'apply', label: 'Apply — reconcile XO to a config file' },
                { value: 'export', label: 'Export — save the current XO config to a file' },
                { value: 'quit', label: 'Quit' },
            ];
            const action = unwrap(await select({ message: 'What would you like to do?', options: actionOptions }));
            if (action === 'quit') {
                break;
            }
            try {
                if (action === 'export') {
                    await runExport(client);
                }
                else {
                    await runDiffApply(client, action === 'apply' ? 'apply' : 'diff');
                }
            }
            catch (error) {
                if (error instanceof Cancelled) {
                    throw error;
                }
                log.error(error instanceof Error ? error.message : String(error));
            }
            const again = unwrap(await confirm({ message: 'Do something else?', initialValue: false }));
            if (!again) {
                break;
            }
        }
        outro(pc.green('Done.'));
        return 0;
    }
    catch (error) {
        if (error instanceof Cancelled) {
            cancel('Cancelled.');
            return 1;
        }
        cancel(pc.red(error instanceof Error ? error.message : String(error)));
        return 1;
    }
    finally {
        client?.close();
    }
}

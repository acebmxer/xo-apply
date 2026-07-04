#!/usr/bin/env node
import { writeFileSync } from 'node:fs';
import { createInterface } from 'node:readline/promises';
import { Command } from 'commander';
import pc from 'picocolors';
import { XoClient } from './client/index.js';
import { loadSpec } from './config/load.js';
import { applyPlan, fetchActualState } from './engine/apply.js';
import { renderPlan } from './engine/diff.js';
import { buildPlan, planHasChanges, planHasDrift } from './engine/plan.js';
import { exportSpec } from './export/export.js';
import { runWizard } from './ui/wizard.js';
const VERSION = '0.1.0';
function getConnection(options) {
    const url = options.url ?? process.env.XO_URL;
    const token = options.token ?? process.env.XO_TOKEN;
    if (url === undefined || token === undefined) {
        console.error(pc.red('error: XO connection not configured.'));
        console.error('Provide --url and --token, or set XO_URL and XO_TOKEN environment variables.');
        console.error('Create a token with: POST /rest/v0/users/me/authentication_tokens (see README).');
        process.exit(1);
    }
    const insecure = options.insecure === true;
    if (insecure) {
        // covers both fetch (REST) and the websocket (JSON-RPC)
        process.env.NODE_TLS_REJECT_UNAUTHORIZED = '0';
    }
    return { url, token, insecure };
}
async function withClient(options, fn) {
    const client = new XoClient(getConnection(options));
    try {
        return await fn(client);
    }
    finally {
        client.close();
    }
}
async function confirm(question) {
    if (!process.stdin.isTTY) {
        console.error(pc.red('error: refusing to apply without confirmation on a non-interactive terminal; use --yes.'));
        process.exit(1);
    }
    const rl = createInterface({ input: process.stdin, output: process.stdout });
    try {
        const answer = await rl.question(`${question} [y/N] `);
        return answer.trim().toLowerCase() === 'y' || answer.trim().toLowerCase() === 'yes';
    }
    finally {
        rl.close();
    }
}
function fail(error) {
    console.error(pc.red(`error: ${error instanceof Error ? error.message : String(error)}`));
    process.exit(1);
}
const program = new Command()
    .name('xo-apply')
    .description('Configuration-as-code for Xen Orchestra: reconcile a running XO against a YAML spec')
    .version(VERSION)
    .option('--url <url>', 'XO base URL (or XO_URL env var), e.g. https://xo.example.lan')
    .option('--token <token>', 'XO authentication token (or XO_TOKEN env var)')
    .option('--insecure', 'skip TLS certificate verification (self-signed certs)');
program
    .command('export')
    .description('read the connected XO and write its configuration as YAML')
    .option('-o, --output <file>', 'write to a file instead of stdout')
    .action(async (cmdOptions) => {
    try {
        await withClient(program.opts(), async (client) => {
            const actual = await fetchActualState(client);
            const { yaml, warnings } = exportSpec(actual);
            for (const warning of warnings) {
                console.error(pc.yellow(`warning: ${warning}`));
            }
            if (cmdOptions.output !== undefined) {
                writeFileSync(cmdOptions.output, yaml);
                console.error(pc.green(`exported to ${cmdOptions.output}`));
            }
            else {
                await new Promise(resolve => process.stdout.write(yaml, () => resolve()));
            }
        });
        // the JSON-RPC websocket can keep the event loop alive after close()
        process.exit(0);
    }
    catch (error) {
        fail(error);
    }
});
program
    .command('diff')
    .description('compare a config file against the connected XO without changing anything')
    .argument('<config>', 'path to the YAML config file')
    .action(async (configPath) => {
    try {
        const exitCode = await withClient(program.opts(), async (client) => {
            const spec = loadSpec(configPath);
            const actual = await fetchActualState(client);
            const plan = buildPlan(spec, actual);
            console.log(renderPlan(plan));
            if (!planHasDrift(plan)) {
                console.log(pc.green('\nIn sync: XO matches the config file.'));
                return 0;
            }
            return 2;
        });
        process.exit(exitCode);
    }
    catch (error) {
        fail(error);
    }
});
program
    .command('apply')
    .description('reconcile the connected XO to match a config file')
    .argument('<config>', 'path to the YAML config file')
    .option('--prune', 'also delete resources that exist in XO but not in the file')
    .option('-y, --yes', 'apply without asking for confirmation')
    .option('--dry-run', 'show the plan and exit without changing anything (same as diff)')
    .action(async (configPath, cmdOptions) => {
    try {
        const prune = cmdOptions.prune === true;
        await withClient(program.opts(), async (client) => {
            const spec = loadSpec(configPath);
            const actual = await fetchActualState(client);
            const plan = buildPlan(spec, actual);
            console.log(renderPlan(plan, { prune }));
            const hasWork = planHasChanges(plan) || (prune && (plan.untrackedRemotes.length > 0 || plan.untrackedJobs.length > 0));
            if (!hasWork) {
                console.log(pc.green('\nNothing to do: XO matches the config file.'));
                return;
            }
            if (cmdOptions.dryRun === true) {
                console.log(pc.dim('\n(dry run: no changes made)'));
                return;
            }
            if (cmdOptions.yes !== true && !(await confirm('\nApply these changes?'))) {
                console.log('aborted');
                process.exitCode = 1;
                return;
            }
            await applyPlan(client, plan, {
                prune,
                log: message => console.log(pc.green(`✓ ${message}`)),
            });
            console.log(pc.green('\nApply complete.'));
        });
        // the JSON-RPC websocket can keep the event loop alive after close()
        process.exit(typeof process.exitCode === 'number' ? process.exitCode : 0);
    }
    catch (error) {
        fail(error);
    }
});
// Bare `xo-apply` (no subcommand) launches the interactive wizard.
// Global options like --url/--token still apply and are read from program.opts()
// inside the wizard via the same env-var fallback the subcommands use.
program.action(async () => {
    try {
        process.exit(await runWizard(program.opts()));
    }
    catch (error) {
        fail(error);
    }
});
program.parseAsync().catch(fail);

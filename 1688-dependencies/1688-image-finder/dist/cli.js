#!/usr/bin/env node
import { Command } from 'commander';
import { CliError } from './io/errors.js';
import { currentCommandName, isJson, isJsonV2, makeEnvelope, setOutputFlags, } from './io/output.js';
import { run as runLogin } from './commands/login.js';
import { run as runImageSearch } from './commands/image-search.js';
import pkg from '../package.json' with { type: 'json' };
const program = new Command();
function writeStderr(message) {
    try {
        process.stderr.write(message);
    }
    catch {
        // ignore
    }
}
program
    .name('1688-image')
    .description('1688 image search CLI (image-finder only)')
    .version(pkg.version);
program
    .command('login')
    .description('Log in to 1688 by scanning a QR code')
    .option('--timeout <seconds>', 'Seconds to wait for QR scan', '300')
    .option('--profile <name>', 'Profile name (default: default)')
    .option('--headed', 'Open Microsoft Edge for interactive login')
    .option('--open-browser', 'Open the dedicated Edge window even when the current session is valid')
    .option('--purpose <purpose>', 'Interactive purpose: login | image_search', process.env.BB1688_LOGIN_PURPOSE)
    .action(async (opts) => {
    await runLogin(opts);
});
program
    .command('image-search')
    .description('Search 1688 by image')
    .argument('<imagePath>', 'Verified local image file path')
    .option('--max <n>', 'Maximum number of results', '20')
    .option('--profile <name>', 'Profile name (default: default)')
    .option('--headed', 'Open Microsoft Edge for risk-control handling')
    .action(async (imagePath, opts) => {
    await runImageSearch({ ...opts, imagePath });
});
function addOutputFlagsToAll(parent) {
    for (const command of parent.commands) {
        addOutputFlagsToAll(command);
        command.option('--json', 'Force JSON output even when stdout is a TTY');
        command.option('--json-v2', 'Emit an opt-in response envelope for agent consumers');
        command.option('--pretty', 'Pretty-print JSON output');
        command.option('--get <path>', 'Print one field by dot-path (a.b[0].c, arr[*].x)');
        command.option('--pick <paths>', 'Emit an object containing comma-separated dot-paths');
    }
}
addOutputFlagsToAll(program);
program.hook('preAction', (_thisCommand, actionCommand) => {
    const opts = actionCommand.optsWithGlobals();
    setOutputFlags({
        json: opts.json,
        jsonV2: opts.jsonV2,
        pretty: opts.pretty,
        get: opts.get,
        pick: opts.pick,
        cmd: actionCommand.name(),
    });
});
try {
    await program.parseAsync();
}
catch (e) {
    if (e instanceof CliError) {
        if (isJsonV2()) {
            writeStderr(JSON.stringify(makeEnvelope({
                cmd: currentCommandName(),
                error: {
                    code: e.code,
                    message: e.message,
                    details: e.details,
                },
                artifactDir: e.details.artifactDir,
                verification: e.details.category
                    ? {
                        state: e.details.category,
                        currentUrl: e.details.currentUrl,
                    }
                    : undefined,
            })) + '\n');
        }
        else if (isJson()) {
            writeStderr(JSON.stringify({
                ok: false,
                code: e.code,
                message: e.message,
                details: e.details,
            }) + '\n');
        }
        else if (e.message) {
            writeStderr(`error: ${e.message}\n`);
            if (e.details.recoverHint) {
                writeStderr(`hint: ${e.details.recoverHint}\n`);
            }
            if (e.details.artifactDir) {
                writeStderr(`debug: ${e.details.artifactDir}\n`);
            }
        }
        process.exit(e.exitCode);
    }
    const error = e;
    const message = error?.message ?? String(e);
    if (/Target page, context or browser has been closed/i.test(message) ||
        /Browser closed|Target closed/i.test(message)) {
        writeStderr('error: Canceled (browser closed).\n');
        process.exit(130);
    }
    writeStderr(`unexpected: ${error.stack ?? message}\n`);
    process.exit(1);
}

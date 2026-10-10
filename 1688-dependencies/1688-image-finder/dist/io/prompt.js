import readline from 'node:readline/promises';
export async function confirm(msg) {
    if (!process.stdin.isTTY)
        return false;
    const rl = readline.createInterface({
        input: process.stdin,
        output: process.stderr,
    });
    try {
        const ans = await rl.question(`${msg} [y/N] `);
        return /^y(es)?$/i.test(ans.trim());
    }
    finally {
        rl.close();
    }
}
//# sourceMappingURL=prompt.js.map
import fs from 'node:fs/promises';
import path from 'node:path';
import { stateFile, ensureRoot } from './paths.js';
const EMPTY = { version: 1 };
export async function readState(profile) {
    try {
        const buf = await fs.readFile(stateFile(profile), 'utf8');
        const parsed = JSON.parse(buf);
        if (parsed?.version !== 1)
            return { ...EMPTY };
        return { ...EMPTY, ...parsed };
    }
    catch (e) {
        if (e.code === 'ENOENT')
            return { ...EMPTY };
        throw e;
    }
}
export async function writeState(s, profile) {
    await ensureRoot();
    await fs.mkdir(path.dirname(stateFile(profile)), { recursive: true });
    await fs.writeFile(stateFile(profile), JSON.stringify(s, null, 2));
}
export async function clearState(profile) {
    await writeState({ ...EMPTY }, profile);
}
//# sourceMappingURL=state.js.map
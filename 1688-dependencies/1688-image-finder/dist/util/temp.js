import os from 'node:os';
import path from 'node:path';
export function debugTmpPath(filename) {
    return path.join(os.tmpdir(), filename);
}
//# sourceMappingURL=temp.js.map
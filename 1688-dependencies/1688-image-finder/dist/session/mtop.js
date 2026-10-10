export function parseMtopJsonp(text) {
    const trimmed = text.trim();
    const match = trimmed.match(/^mtopjsonp\w+\(([\s\S]*)\)$/);
    return JSON.parse(match ? match[1] : trimmed);
}
export const parseMtop = parseMtopJsonp;
//# sourceMappingURL=mtop.js.map
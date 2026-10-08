import { writeFile } from "node:fs/promises";
import { createSyntheticArtifacts } from "./synthetic-fixtures.mjs";

const artifacts = createSyntheticArtifacts();
await writeFile(new URL("./analysis-to-procurement.synthetic.json", import.meta.url), JSON.stringify(artifacts.handoff, null, 2) + "\n", "utf8");
await writeFile(new URL("./formula-parity.synthetic.json", import.meta.url), JSON.stringify(artifacts.formula, null, 2) + "\n", "utf8");
console.log(JSON.stringify({ synthetic: true, passed: artifacts.handoff.products.length, excluded: artifacts.handoff.audit.excluded, pending: artifacts.handoff.audit.pending, formulaCases: artifacts.formula.cases.length }));

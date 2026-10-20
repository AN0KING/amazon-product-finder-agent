import { createHash, randomBytes } from "node:crypto";
import { lstat, mkdir, readFile, readdir, rename, unlink, writeFile } from "node:fs/promises";
import path from "node:path";

const STORAGE = Symbol("runPartitions");
const PARTS = ["searchBatches", "asinDetails", "competitorLookups", "amazonStoreCheckpoints", "collectionJob", "collectionItems", "snapshotMetadata", "snapshotProducts"];
const CORE = ["collectionJob", "collectionItems", "snapshotMetadata", "snapshotProducts"];
const HASH = /^[a-f0-9]{64}$/;
const THRESHOLD = 1024 * 1024;
const locks = new Map();

// Readers hold this lock until all referenced immutable chunks have been read.
// This permits removing superseded chunks after the atomic manifest commit.
async function exclusive(file, operation) {
  const previous = locks.get(file) || Promise.resolve();
  const pending = previous.catch(() => {}).then(operation);
  locks.set(file, pending);
  try { return await pending; }
  finally { if (locks.get(file) === pending) locks.delete(file); }
}

export async function readPartitionedRun(file, { sections = CORE } = {}) {
  return exclusive(file, async () => {
    const document = JSON.parse(await readFile(file, "utf8"));
    if (!document.runPartitions) return document;
    const storage = document.runPartitions;
    if (storage.version !== 1 || !storage.refs || typeof storage.refs !== "object") throw new Error("Invalid run partition manifest");
    for (const [name, hash] of Object.entries(storage.refs)) {
      if (!PARTS.includes(name) || !HASH.test(hash)) throw new Error("Invalid run partition reference");
    }
    delete document.runPartitions;
    document[STORAGE] = storage;
    const requested = sections === "all" ? PARTS : sections;
    const values = await Promise.all(requested.map(async name => {
      if (!PARTS.includes(name)) throw new Error("Unknown run partition");
      const hash = storage.refs[name];
      if (!hash) return [name, undefined];
      let data;
      try {
        await assertRegularDirectory(`${file}.parts`);
        const info = await lstat(chunkPath(file, hash));
        if (!info.isFile() || info.isSymbolicLink()) throw new Error("Invalid run partition file");
        data = await readFile(chunkPath(file, hash), "utf8");
      } catch (error) { throw new Error("Run partition is unavailable", { cause: error }); }
      if (digest(data) !== hash) throw new Error("Run partition integrity check failed");
      return [name, JSON.parse(data)];
    }));
    for (const [name, value] of values) {
      if (value === undefined) continue;
      if (name === "collectionJob") (document.amazonCollection ||= {}).job = value;
      else if (name === "collectionItems") (document.amazonCollection ||= {}).items = value;
      else if (name === "snapshotMetadata") document.snapshot = { ...(document.snapshot || {}), ...value };
      else if (name === "snapshotProducts") (document.snapshot ||= {}).products = value;
      else document[name] = value;
    }
    return document;
  });
}

export async function writePartitionedRun(file, document, { commit = atomicJson } = {}) {
  return exclusive(file, async () => {
    const previous = document[STORAGE];
    // Existing small artifacts keep their original self-contained format.
    const compact = previous ? null : JSON.stringify(document);
    if (!previous && Buffer.byteLength(compact, "utf8") < THRESHOLD) {
      await commit(file, document);
      return;
    }
    const manifest = { ...document };
    const refs = { ...(previous?.refs || {}) };
    const values = {};
    for (const key of PARTS.slice(0, 4)) {
      if (Object.hasOwn(document, key)) values[key] = document[key];
      delete manifest[key];
    }
    if (document.amazonCollection) {
      if (Object.hasOwn(document.amazonCollection, "job")) values.collectionJob = document.amazonCollection.job;
      if (Object.hasOwn(document.amazonCollection, "items")) values.collectionItems = document.amazonCollection.items;
    }
    delete manifest.amazonCollection;
    if (document.snapshot) {
      if (Object.hasOwn(document.snapshot, "products")) values.snapshotProducts = document.snapshot.products;
      const metadata = { ...document.snapshot };
      delete metadata.products;
      values.snapshotMetadata = metadata;
    } else if (Object.hasOwn(document, "snapshot")) {
      delete refs.snapshotMetadata;
      delete refs.snapshotProducts;
      manifest.snapshot = null;
    }
    if (document.snapshot) delete manifest.snapshot;
    await mkdir(`${file}.parts`, { recursive: true });
    await assertRegularDirectory(`${file}.parts`);
    for (const [name, value] of Object.entries(values)) {
      if (value === undefined) continue;
      const text = JSON.stringify(value);
      const hash = digest(text);
      if (refs[name] !== hash) {
        // Chunks also use temp + rename: an interrupted file write must never
        // leave a truncated hash-named chunk that a later commit could reuse.
        await atomicText(chunkPath(file, hash), text);
      }
      refs[name] = hash;
    }
    manifest.runPartitions = { version: 1, refs };
    // All chunks exist before this sole commit point. A failed commit leaves
    // the old manifest and its chunks readable, including all manual fields.
    await commit(file, manifest);
    document[STORAGE] = manifest.runPartitions;
    const retained = new Set(Object.values(refs).map(hash => `${hash}.json`));
    for (const name of await readdir(`${file}.parts`).catch(() => [])) {
      if (/^[a-f0-9]{64}\.json$/.test(name) && !retained.has(name)) {
        await unlink(path.join(`${file}.parts`, name)).catch(() => {});
      }
    }
  });
}

export function isPartitionedRun(document) { return Boolean(document?.[STORAGE]); }
async function assertRegularDirectory(directory) {
  const info = await lstat(directory);
  if (!info.isDirectory() || info.isSymbolicLink()) throw new Error("Invalid run partition directory");
}
function digest(value) { return createHash("sha256").update(value).digest("hex"); }
function chunkPath(file, hash) { return path.join(`${file}.parts`, `${hash}.json`); }
async function atomicJson(file, value) {
  return atomicText(file, `${JSON.stringify(value)}\n`);
}
async function atomicText(file, text) {
  await mkdir(path.dirname(file), { recursive: true });
  const temp = `${file}.${process.pid}.${randomBytes(8).toString("hex")}.tmp`;
  try {
    await writeFile(temp, text, { encoding: "utf8", flag: "wx" });
    await rename(temp, file);
  } catch (error) {
    await unlink(temp).catch(() => {});
    throw error;
  }
}

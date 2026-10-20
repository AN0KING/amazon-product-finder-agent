import path from "node:path";
import { localDirectory } from "../../1688-image-finder/dist/util/local-path.js";

export const LEGACY_PROCUREMENT_ROOT = "D:\\deliverables\\1688-procurement-assistant-2.3.0";
export const LEGACY_IMAGE_FINDER_ROOT = "D:\\deliverables\\1688-image-finder";

export function resolve1688RuntimePaths({ env = process.env, projectRoot = LEGACY_PROCUREMENT_ROOT, platform = process.platform, fsImpl } = {}) {
  const paths = platform === "win32" ? path.win32 : path.posix;
  const options = { platform, ...(fsImpl ? { fsImpl } : {}) };
  const procurementRoot = localDirectory(env.SCOUT_1688_PROJECT_ROOT || projectRoot, "SCOUT_1688_PROJECT_ROOT", options);
  const imageFinderRoot = localDirectory(env.BB1688_IMAGE_FINDER_ROOT || LEGACY_IMAGE_FINDER_ROOT, "BB1688_IMAGE_FINDER_ROOT", options);
  const sessionRoot = localDirectory(env.BB1688_HOME || paths.join(imageFinderRoot, "data", "1688-session"), "BB1688_HOME", options);
  const dataRoot = localDirectory(env.BB1688_DATA_ROOT || paths.join(procurementRoot, "data", "sourcing-console"), "BB1688_DATA_ROOT", options);
  return { procurementRoot, imageFinderRoot, sessionRoot, dataRoot };
}

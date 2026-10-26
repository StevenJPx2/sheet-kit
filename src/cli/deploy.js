// Push a compiled Apps Script project and (re)deploy it through the Apps Script
// API: projects.updateContent → projects.versions.create →
// projects.deployments.update (same deployment id, so the /macros/s/<id>/exec
// URL is unchanged) or projects.deployments.create when no id is given.
import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { extname, isAbsolute, join } from "node:path";
import { googleJson } from "../google/http.js";

const API = "https://script.googleapis.com/v1/projects";
const MANIFEST = "appsscript";

/**
 * @typedef {Object} DeployOptions
 * @property {string}  projectDir
 * @property {string} [scriptId]
 * @property {string} [deploymentId]
 * @property {string} [description]
 *
 * @typedef {{ name: string, type: "SERVER_JS" | "HTML" | "JSON", source: string }} ScriptFile
 * @typedef {{ scriptId: string, versionNumber: number, deploymentId: string, url: string, created: boolean }} DeployResult
 */

/** @type {Record<string, ScriptFile["type"]>} */
const TYPES = { ".gs": "SERVER_JS", ".js": "SERVER_JS", ".html": "HTML" };

/**
 * The script id and source dir: --script-id wins; else a clasp-era .clasp.json
 * (scriptId + optional rootDir) in the project dir.
 * @param {DeployOptions} options
 * @returns {{ scriptId: string, sourceDir: string }}
 */
export function resolveProject(options) {
  if (options.scriptId) return { scriptId: options.scriptId, sourceDir: options.projectDir };
  const claspPath = join(options.projectDir, ".clasp.json");
  if (!existsSync(claspPath)) throw new Error("missing --script-id (and no .clasp.json in the project dir)");
  const clasp = JSON.parse(readFileSync(claspPath, "utf8"));
  if (!clasp.scriptId) throw new Error(`${claspPath} has no scriptId`);
  const root = clasp.rootDir ?? ".";
  return { scriptId: clasp.scriptId, sourceDir: isAbsolute(root) ? root : join(options.projectDir, root) };
}

/**
 * The project's files in Apps Script API form. Top level only (compile output
 * is flat); the manifest must be appsscript.json.
 * @param {string} dir
 * @returns {ScriptFile[]}
 */
export function readProjectFiles(dir) {
  if (!existsSync(join(dir, `${MANIFEST}.json`))) throw new Error(`missing generated Apps Script manifest: ${join(dir, `${MANIFEST}.json`)}`);
  /** @type {ScriptFile[]} */
  const files = [];
  for (const entry of readdirSync(dir).sort()) {
    if (entry.startsWith(".") || !statSync(join(dir, entry)).isFile()) continue;
    const ext = extname(entry);
    const name = entry.slice(0, -ext.length);
    const type = entry === `${MANIFEST}.json` ? "JSON" : TYPES[ext];
    if (!type) continue;
    if (files.some((f) => f.name === name)) throw new Error(`two project files map to the Apps Script name "${name}"`);
    files.push({ name, type, source: readFileSync(join(dir, entry), "utf8") });
  }
  return files;
}

/**
 * @param {DeployOptions} options
 * @param {{ token: string, fetchImpl?: typeof fetch, log?: (msg: string) => void }} deps
 * @returns {Promise<DeployResult>}
 */
export async function deployAppsScript(options, { token, fetchImpl = fetch, log = () => {} }) {
  const { scriptId, sourceDir } = resolveProject(options);
  const files = readProjectFiles(sourceDir);
  const project = `${API}/${encodeURIComponent(scriptId)}`;
  const description = options.description ?? "";

  await googleJson(token, "PUT", `${project}/content`, { files }, fetchImpl);
  log(`pushed ${files.length} file(s) to ${scriptId}`);

  const version = await googleJson(token, "POST", `${project}/versions`, { description }, fetchImpl);
  const versionNumber = Number(version.versionNumber);
  if (!Number.isInteger(versionNumber)) throw new Error("versions.create returned no versionNumber");

  const config = { versionNumber, manifestFileName: MANIFEST, description };
  const deployment = options.deploymentId
    ? await googleJson(token, "PUT", `${project}/deployments/${encodeURIComponent(options.deploymentId)}`,
      { deploymentConfig: { scriptId, ...config } }, fetchImpl)
    : await googleJson(token, "POST", `${project}/deployments`, config, fetchImpl);

  const deploymentId = String(deployment.deploymentId ?? options.deploymentId ?? "");
  const webApp = (deployment.entryPoints ?? []).find((e) => e.entryPointType === "WEB_APP");
  const url = String(webApp?.webApp?.url ?? "");
  log(`${options.deploymentId ? "updated" : "created"} deployment ${deploymentId} @${versionNumber}`);
  if (url) log(`web app: ${url}`);
  return { scriptId, versionNumber, deploymentId, url, created: !options.deploymentId };
}

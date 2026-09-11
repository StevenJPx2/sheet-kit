// Canonical rows artifact + coverage check.
import { CONTRACT_VERSION } from "./validate.js";

/**
 * @param {import("./types.js").Data} d
 * @returns {string}
 */
export function validateData(d) {
  if (d.contract_version !== CONTRACT_VERSION) {
    return `contract_version ${d.contract_version} unsupported (this build speaks ${CONTRACT_VERSION})`;
  }
  if (!d.datasets) return "datasets is required";
  return "";
}

/**
 * Every manifest tab must have a matching dataset.
 * @param {import("./types.js").Manifest} m
 * @param {import("./types.js").Data} d
 * @returns {string}
 */
export function checkCoverage(m, d) {
  for (const tab of m.tabs) {
    if (!(tab.data_key in d.datasets)) {
      return `tab ${JSON.stringify(tab.name)} wants dataset ${JSON.stringify(tab.data_key)}, absent from data.json`;
    }
  }
  return "";
}

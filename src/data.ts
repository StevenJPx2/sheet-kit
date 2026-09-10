// Canonical rows artifact (contract/data.schema.json) + coverage check.
import { CONTRACT_VERSION, type Manifest } from "./manifest.ts";

export type Row = Record<string, string | number | null>;

export interface Data {
  contract_version: number;
  generated_at?: string;
  datasets: Record<string, Row[]>;
}

export function validateData(d: Data): string {
  if (d.contract_version !== CONTRACT_VERSION) {
    return `contract_version ${d.contract_version} unsupported (this build speaks ${CONTRACT_VERSION})`;
  }
  if (!d.datasets) return "datasets is required";
  return "";
}

/** Every manifest tab must have a matching dataset. */
export function checkCoverage(m: Manifest, d: Data): string {
  for (const tab of m.tabs) {
    if (!(tab.data_key in d.datasets)) {
      return `tab ${JSON.stringify(tab.name)} wants dataset ${JSON.stringify(tab.data_key)}, absent from data.json`;
    }
  }
  return "";
}

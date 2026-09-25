// Flattens package-lock.json `packages` into rows for generate-windows-licenses.ps1.
// Windows PowerShell 5.1's ConvertFrom-Json rejects the empty root key ("")
// that lockfile v3 uses, so the map never reaches PowerShell directly.
import { readFileSync } from "node:fs";

const lock = JSON.parse(readFileSync(process.argv[2], "utf8"));
const MODULES = "node_modules/";
const rows = Object.entries(lock.packages || {})
  .filter(([path, meta]) => path && meta && meta.version)
  .map(([path, meta]) => ({
    path,
    name: meta.name || path.slice(path.lastIndexOf(MODULES) + MODULES.length),
    version: meta.version,
    license: typeof meta.license === "string" ? meta.license : null,
  }));
process.stdout.write(JSON.stringify(rows));

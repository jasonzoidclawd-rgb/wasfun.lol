// Verify Windows installer artifacts are named deterministically and carry the
// release version. Tauri v2 emits, for productName "Mayhem Oracle" @ 0.5.0 on
// x64:
//   nsis/Mayhem Oracle_0.5.0_x64-setup.exe
//   msi/Mayhem Oracle_0.5.0_x64_en-US.msi
// Every name must include the product, the exact version and the architecture,
// and end with the installer-type suffix. Safe to run anywhere: when no Windows
// bundle exists (e.g. on macOS/CI without a build) it reports and exits 0.
import { readdir } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { readFileSync } from "node:fs";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const overlayRoot = path.resolve(__dirname, "..");

const version = JSON.parse(
  readFileSync(path.join(overlayRoot, "src-tauri", "tauri.conf.json"), "utf8"),
).version;

const CHECKS = [
  { dir: "nsis", ext: ".exe", suffix: "-setup.exe", type: "NSIS installer" },
  { dir: "msi", ext: ".msi", suffix: ".msi", type: "MSI installer" },
];

async function listOrNull(dir) {
  try {
    return await readdir(dir);
  } catch {
    return null;
  }
}

async function main() {
  const bundleRoot =
    process.argv[2] ??
    path.join(overlayRoot, "src-tauri", "target", "release", "bundle");

  const violations = [];
  let checkedAny = false;

  for (const { dir, ext, suffix, type } of CHECKS) {
    const names = await listOrNull(path.join(bundleRoot, dir));
    if (names === null) continue;
    const artifacts = names.filter((name) => name.toLowerCase().endsWith(ext));
    if (artifacts.length === 0) continue;
    checkedAny = true;

    for (const name of artifacts) {
      if (!name.includes(version)) {
        violations.push(`${type}: "${name}" is missing version ${version}`);
      }
      if (!/x64|x86_64|amd64|arm64|aarch64/i.test(name)) {
        violations.push(`${type}: "${name}" is missing an architecture token`);
      }
      if (!name.toLowerCase().endsWith(suffix)) {
        violations.push(`${type}: "${name}" does not end with ${suffix}`);
      }
      if (!/mayhem/i.test(name)) {
        violations.push(`${type}: "${name}" is missing the product name`);
      }
    }
  }

  if (violations.length > 0) {
    console.error(`Windows artifact-name audit failed:\n${violations.join("\n")}`);
    process.exitCode = 1;
    return;
  }

  if (!checkedAny) {
    console.log(
      `No Windows installers found under ${path.relative(overlayRoot, bundleRoot)} — nothing to verify (expected on non-Windows hosts).`,
    );
    return;
  }
  console.log(`Windows artifact-name audit passed for version ${version}.`);
}

main();

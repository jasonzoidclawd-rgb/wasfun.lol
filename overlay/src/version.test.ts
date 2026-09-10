/**
 * Version-consistency guard (release policy).
 *
 * Every authoritative version declaration for the overlay application MUST agree
 * and equal the single release version below. The runtime "About"/bundle version
 * Tauri reports comes from `src-tauri/tauri.conf.json`, so asserting that file is
 * what makes "runtime version reports 0.5.0" true; the crate, the JS package and
 * the generated lockfile are pinned to the same string so a partial bump fails
 * CI instead of shipping mismatched metadata.
 *
 * Dependency versions, schema versions and API versions are deliberately NOT
 * checked here — only the application/release version.
 */
import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

const RELEASE_VERSION = "0.5.0";

function read(relative: string): string {
  return readFileSync(new URL(relative, import.meta.url), "utf8");
}

/** `version = "x.y.z"` immediately under the `[package]` table (crate version). */
function cargoPackageVersion(toml: string): string | null {
  const pkg = toml.split(/^\[/m).find((section) => section.startsWith("package]"));
  return pkg?.match(/^\s*version\s*=\s*"([^"]+)"/m)?.[1] ?? null;
}

/** The version of the `mayhem-oracle-overlay` package entry in Cargo.lock. */
function cargoLockOverlayVersion(lock: string): string | null {
  const block = lock
    .split(/^\[\[package\]\]/m)
    .find((section) => /name\s*=\s*"mayhem-oracle-overlay"/.test(section));
  return block?.match(/version\s*=\s*"([^"]+)"/)?.[1] ?? null;
}

describe("application version consistency", () => {
  const sources: Record<string, string | null> = {
    "package.json": (JSON.parse(read("../package.json")) as { version?: string }).version ?? null,
    "src-tauri/tauri.conf.json":
      (JSON.parse(read("../src-tauri/tauri.conf.json")) as { version?: string }).version ?? null,
    "src-tauri/Cargo.toml": cargoPackageVersion(read("../src-tauri/Cargo.toml")),
    "src-tauri/Cargo.lock": cargoLockOverlayVersion(read("../src-tauri/Cargo.lock")),
  };

  for (const [file, version] of Object.entries(sources)) {
    it(`${file} declares the release version ${RELEASE_VERSION}`, () => {
      expect(version, `${file} version could not be parsed`).not.toBeNull();
      expect(version).toBe(RELEASE_VERSION);
    });
  }

  it("every authoritative source agrees on exactly one version", () => {
    const distinct = new Set(Object.values(sources));
    expect(distinct.size, `version drift across ${JSON.stringify(sources)}`).toBe(1);
  });
});

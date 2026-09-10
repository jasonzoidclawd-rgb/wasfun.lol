import { access, readdir, readFile, stat } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const REQUIRED_PUBLIC_DATA = [
  "augments.json",
  "champions.json",
  "combos.json",
  "pool-rules.json",
];

const TEXT_EXTENSIONS = new Set([
  ".css",
  ".html",
  ".ini",
  ".json",
  ".js",
  ".mjs",
  ".svg",
  ".toml",
  ".txt",
  ".xml",
  ".yaml",
  ".yml",
]);

const FORBIDDEN_PATH_PATTERNS = [
  /(^|[\\/])\.env(?:$|[.\-_])/i,
  /(^|[\\/])\.env$/i,
  /raw[-_ ]?lcu/i,
  /raw[-_ ]?screenshot/i,
  /screenshot[-_ ]?(raw|full|capture)/i,
  /google[-_ ]?application[-_ ]?credentials/i,
  /service[-_ ]?account/i,
  /bigquery[-_ ]?credentials/i,
];

const FORBIDDEN_TEXT_PATTERNS = [
  /RGAPI-[A-Za-z0-9-]+/,
  /\bRIOT_API_KEY\b/,
  /\bGOOGLE_APPLICATION_CREDENTIALS\b/,
  /\bBIGQUERY_PROJECT_ID\b/,
  /\bBIGQUERY_DATASET\b/,
  /"private_key"\s*:/,
  /"client_email"\s*:/,
  /\brawLcu\b/i,
  /\braw_lcu\b/i,
  /ARAMGG\s+(?:PREVIEW|TIER\s+FIXTURE)/i,
  /(?:\/aramgg-dev|https:\/\/aramgg\.com|mayhem-aramgg-fixture-cache|\[aramgg-fixture\])/i,
  /MAYHEM_OVERLAY_(?:TIER_FIXTURE|GEOMETRY_PREVIEW)/i,
  /data-dev-only/i,
  /OCR unavailable\s+—/i,
  /force-refresh/i,
  /Foreground:\s*app=/i,
  /calibration-panel/i,
  /\[geometry-(?:probe|full-latency|freshness-75|hidden|watchdog)\]/i,
  /__getGeometryProbeDiagnostics/i,
];

const REMOTE_RENDERER_PATTERNS = [
  /<script\b[^>]*\bsrc=["']https?:\/\//i,
  /\bimport\s*\(\s*["']https?:\/\//i,
];

async function exists(filePath) {
  try {
    await access(filePath);
    return true;
  } catch {
    return false;
  }
}

async function listFiles(root) {
  const entries = await readdir(root, { withFileTypes: true });
  const files = [];
  for (const entry of entries) {
    const fullPath = path.join(root, entry.name);
    if (entry.isDirectory()) {
      files.push(...await listFiles(fullPath));
    } else if (entry.isFile()) {
      files.push(fullPath);
    }
  }
  return files;
}

function relative(overlayRoot, filePath) {
  return path.relative(overlayRoot, filePath).split(path.sep).join("/");
}

async function assertJsonFile(filePath) {
  const text = await readFile(filePath, "utf-8");
  JSON.parse(text);
}

async function assertPublicData(overlayRoot) {
  const publicDataRoot = path.join(overlayRoot, "public", "data");
  for (const filename of REQUIRED_PUBLIC_DATA) {
    await assertJsonFile(path.join(publicDataRoot, filename));
  }

  await assertAbilityData(publicDataRoot, "public/data");
}

async function assertAbilityData(root, label) {
  const abilitiesRoot = path.join(root, "abilities");
  if (!(await exists(abilitiesRoot))) {
    throw new Error(`artifact audit failed: no ability JSON files found in ${label}`);
  }
  const abilities = await readdir(abilitiesRoot);
  if (!abilities.some((name) => name.endsWith(".json"))) {
    throw new Error(`artifact audit failed: no ability JSON files found in ${label}`);
  }
}

async function assertCapabilities(overlayRoot) {
  const capabilitiesRoot = path.join(overlayRoot, "src-tauri", "capabilities");
  const files = await readdir(capabilitiesRoot);
  const capabilityFiles = files.filter((name) => name.endsWith(".json"));
  if (capabilityFiles.length === 0) {
    throw new Error("artifact audit failed: no Tauri capability JSON files found");
  }
  for (const filename of capabilityFiles) {
    await assertJsonFile(path.join(capabilitiesRoot, filename));
  }
}

async function assertBuiltRendererData(overlayRoot) {
  const distRoot = path.join(overlayRoot, "dist");
  if (!(await exists(distRoot))) return;

  const indexPath = path.join(distRoot, "index.html");
  if (!(await exists(indexPath))) {
    throw new Error("artifact audit failed: dist/index.html is missing");
  }

  const distDataRoot = path.join(distRoot, "data");
  if (!(await exists(distDataRoot))) {
    throw new Error("artifact audit failed: dist/data is missing packaged public data");
  }
  for (const filename of REQUIRED_PUBLIC_DATA) {
    await assertJsonFile(path.join(distDataRoot, filename));
  }
  await assertAbilityData(distDataRoot, "dist/data");
}

async function assertTauriConfig(overlayRoot) {
  const configPath = path.join(overlayRoot, "src-tauri", "tauri.conf.json");
  const config = JSON.parse(await readFile(configPath, "utf-8"));
  const frontendDist = config?.build?.frontendDist;
  if (typeof frontendDist !== "string" || /^https?:\/\//i.test(frontendDist)) {
    throw new Error("artifact audit failed: Tauri renderer must be bundled locally");
  }
  if (config?.plugins?.updater) {
    throw new Error("artifact audit failed: Tauri updater config must stay disabled");
  }
}

async function artifactRoots(overlayRoot) {
  const candidates = [
    path.join(overlayRoot, "public", "data"),
    path.join(overlayRoot, "dist"),
    path.join(overlayRoot, "src-tauri", "capabilities"),
    path.join(overlayRoot, "src-tauri", "target", "release", "bundle"),
  ];

  const roots = [];
  for (const root of candidates) {
    if (await exists(root)) roots.push(root);
  }
  return roots;
}

async function scanArtifactRoots(overlayRoot, roots) {
  const violations = [];
  for (const root of roots) {
    const rootStat = await stat(root);
    if (!rootStat.isDirectory()) continue;

    for (const filePath of await listFiles(root)) {
      const rel = relative(overlayRoot, filePath);
      const normalized = rel.toLowerCase();
      for (const pattern of FORBIDDEN_PATH_PATTERNS) {
        if (pattern.test(normalized)) {
          violations.push(`${rel}: forbidden path pattern ${pattern}`);
        }
      }

      if (!TEXT_EXTENSIONS.has(path.extname(filePath).toLowerCase())) continue;

      const text = await readFile(filePath, "utf-8");
      for (const pattern of FORBIDDEN_TEXT_PATTERNS) {
        if (pattern.test(text)) {
          violations.push(`${rel}: forbidden text pattern ${pattern}`);
        }
      }
      for (const pattern of REMOTE_RENDERER_PATTERNS) {
        if (pattern.test(text)) {
          violations.push(`${rel}: remote renderer JavaScript pattern ${pattern}`);
        }
      }
    }
  }

  if (violations.length > 0) {
    throw new Error(`artifact audit found forbidden content:\n${violations.join("\n")}`);
  }
}

export async function auditWindowsArtifact({
  overlayRoot = path.resolve(__dirname, ".."),
} = {}) {
  await assertPublicData(overlayRoot);
  await assertBuiltRendererData(overlayRoot);
  await assertCapabilities(overlayRoot);
  await assertTauriConfig(overlayRoot);
  const roots = await artifactRoots(overlayRoot);
  await scanArtifactRoots(overlayRoot, roots);

  return {
    checkedRoots: roots.map((root) => relative(overlayRoot, root)),
  };
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  try {
    const result = await auditWindowsArtifact();
    console.log(`Windows artifact audit passed: ${result.checkedRoots.join(", ")}`);
  } catch (error) {
    console.error(error instanceof Error ? error.message : error);
    process.exitCode = 1;
  }
}

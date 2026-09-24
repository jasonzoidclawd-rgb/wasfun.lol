#!/usr/bin/env node
/**
 * Download icon art at build time into the site's own assets (never hotlinked):
 *
 *   augments   CommunityDragon art, by augmentId      → public/assets/icons/aug/<augmentId>.png
 *   champions  Data Dragon squares, by champion slug   → public/assets/icons/champ/<slug>.png
 *   items      CommunityDragon art, by item id         → public/assets/icons/item/<id>.png
 *
 * Writes public/assets/icons/manifest.json listing what exists. Anything that
 * fails to download keeps its placeholder glyph: a blocked network degrades
 * the art, never the build. Runs as `prebuild`.
 */
import { mkdir, readFile, writeFile, access } from "node:fs/promises";
import path from "node:path";

const ROOT = path.resolve(path.dirname(new URL(import.meta.url).pathname), "..");
const DATA = path.join(ROOT, "data", "internal");
const OUT = path.join(ROOT, "public", "assets", "icons");
const TIMEOUT_MS = 10_000;
const CONCURRENCY = 12;

const norm = (s) => String(s ?? "").toLowerCase().replace(/[^a-z0-9]+/g, "");

async function exists(file) {
  try {
    await access(file);
    return true;
  } catch {
    return false;
  }
}

async function download(url, file) {
  if (await exists(file)) return true;
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), TIMEOUT_MS);
  try {
    const res = await fetch(url, { signal: ctrl.signal, headers: { "User-Agent": "wasfun.lol build (icons)" } });
    if (!res.ok) return false;
    const type = res.headers.get("content-type") ?? "";
    if (!type.startsWith("image/")) return false;
    await writeFile(file, Buffer.from(await res.arrayBuffer()));
    return true;
  } catch {
    return false;
  } finally {
    clearTimeout(timer);
  }
}

async function pool(tasks) {
  const results = [];
  let i = 0;
  await Promise.all(
    Array.from({ length: CONCURRENCY }, async () => {
      while (i < tasks.length) {
        const task = tasks[i++];
        results.push(await task());
      }
    }),
  );
  return results;
}

async function readJson(file) {
  return JSON.parse(await readFile(file, "utf-8"));
}

async function main() {
  for (const dir of ["aug", "champ", "item"]) await mkdir(path.join(OUT, dir), { recursive: true });
  const manifest = { generatedAt: new Date().toISOString(), augments: [], champions: [], items: {} };

  const augments = (await readJson(path.join(DATA, "augments.json"))).augments.filter((a) => a.augmentId && a.icon);
  const seen = new Set();
  const augTasks = augments
    .filter((a) => !seen.has(a.augmentId) && seen.add(a.augmentId))
    .map((a) => async () => {
      const ok = await download(a.icon, path.join(OUT, "aug", `${a.augmentId}.png`));
      if (ok) manifest.augments.push(a.augmentId);
      return ok;
    });

  let champTasks = [];
  try {
    const versions = await (await fetch("https://ddragon.leagueoflegends.com/api/versions.json")).json();
    const v = versions[0];
    const dd = await (await fetch(`https://ddragon.leagueoflegends.com/cdn/${v}/data/en_US/champion.json`)).json();
    const byKey = new Map(Object.values(dd.data).map((c) => [String(c.key), c.id]));
    const champions = (await readJson(path.join(DATA, "champions.json"))).champions;
    champTasks = champions
      .filter((c) => byKey.has(String(c.id)))
      .map((c) => async () => {
        const url = `https://ddragon.leagueoflegends.com/cdn/${v}/img/champion/${byKey.get(String(c.id))}.png`;
        const ok = await download(url, path.join(OUT, "champ", `${c.slug}.png`));
        if (ok) manifest.champions.push(c.slug);
        return ok;
      });
  } catch {
    // Data Dragon unreachable: champion portraits keep their placeholders.
  }

  const itemsDoc = await readJson(path.join(DATA, "items.json"));
  const items = [...(itemsDoc.mayhemExclusive ?? []), ...(itemsDoc.items ?? [])].filter((i) => i.id && i.icon);
  const itemTasks = items.map((i) => async () => {
    const ok = await download(i.icon, path.join(OUT, "item", `${i.id}.png`));
    if (ok) manifest.items[norm(i.name)] = String(i.id);
    return ok;
  });

  const results = await pool([...augTasks, ...champTasks, ...itemTasks]);
  manifest.augments.sort();
  manifest.champions.sort();
  await writeFile(path.join(OUT, "manifest.json"), JSON.stringify(manifest) + "\n");
  const ok = results.filter(Boolean).length;
  console.log(
    `icons: ${ok}/${results.length} available (augments ${manifest.augments.length}, champions ${manifest.champions.length}, items ${Object.keys(manifest.items).length})`,
  );
}

main().catch((err) => {
  // Never fail the build over art.
  console.warn(`icons: skipped (${err?.message ?? err}); placeholders stay`);
});

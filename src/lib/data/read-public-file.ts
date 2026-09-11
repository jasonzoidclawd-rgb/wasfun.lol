import { readFile } from "node:fs/promises";
import path from "node:path";

/**
 * One named export per file, each with the filename written as a literal
 * directly in its own path.join() call — unlike public-loader.ts's
 * loadPublicJson() (which statically imports all eight files into one
 * module) or a single generic readFile(filename) helper (which would work
 * at the source level but defeats Vercel's build-output file tracer: a
 * dynamic path argument can't be resolved to one file, so the tracer falls
 * back to bundling the entire public/data/ directory — including the
 * 1.7MB abilities.json — into every route that calls it. A literal argument
 * lets the tracer resolve and bundle only that one file. Add more functions
 * the same way as new callers need other public/data files.
 */

async function parseJsonFile<T>(filePath: string): Promise<T> {
  const raw = await readFile(filePath, "utf-8");
  return JSON.parse(raw) as T;
}

export function readChampionsFile<T>(): Promise<T> {
  return parseJsonFile<T>(path.join(process.cwd(), "public", "data", "champions.json"));
}

export function readAugmentsFile<T>(): Promise<T> {
  return parseJsonFile<T>(path.join(process.cwd(), "public", "data", "augments.json"));
}

export function readItemsFile<T>(): Promise<T> {
  return parseJsonFile<T>(path.join(process.cwd(), "public", "data", "items.json"));
}

export function readMetaFile<T>(): Promise<T> {
  return parseJsonFile<T>(path.join(process.cwd(), "public", "data", "meta.json"));
}

export function readPatchNotesFile<T>(): Promise<T> {
  return parseJsonFile<T>(path.join(process.cwd(), "public", "data", "patch-notes.json"));
}

export function readPbePreviewFile<T>(): Promise<T> {
  return parseJsonFile<T>(path.join(process.cwd(), "public", "data", "pbe-preview.json"));
}

export function readCombosFile<T>(): Promise<T> {
  return parseJsonFile<T>(path.join(process.cwd(), "public", "data", "combos.json"));
}

export function readPipelineStatusFile<T>(): Promise<T> {
  return parseJsonFile<T>(path.join(process.cwd(), "public", "data", "pipeline-status.json"));
}

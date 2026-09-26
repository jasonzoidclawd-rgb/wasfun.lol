"use client";

/**
 * Member conveniences kept in this browser only: This game, saved games and
 * followed champions. Nothing is sent to the server. Every number these
 * features show is public already (every letter and number is free), so the
 * store holds choices, never statistics. Storage can be blocked (private
 * mode): then the features work for the visit and forget afterwards.
 */
import { useSyncExternalStore } from "react";
import type { ThisGame } from "@/lib/score/this-game";

const KEYS = { game: "wasfun:this-game", saved: "wasfun:saved-games", following: "wasfun:following" } as const;
type Key = keyof typeof KEYS;

export const SAVED_GAMES_MAX = 20;
export const FOLLOWING_MAX = 30;

export interface SavedGame extends ThisGame {
  patch: string;
  savedAt: string;
}

interface Shape {
  game: ThisGame | null;
  saved: SavedGame[];
  following: string[];
}

const EMPTY: Shape = { game: null, saved: [], following: [] };
const memory: Partial<Shape> = {};
const listeners = new Set<() => void>();

function isScreen(x: unknown): boolean {
  const s = x as ThisGame["screens"][number];
  return !!s && typeof s === "object" && typeof s.level === "number" && typeof s.taken === "string" && Array.isArray(s.offered);
}

function isGame(x: unknown): x is ThisGame {
  return (
    !!x &&
    typeof x === "object" &&
    typeof (x as ThisGame).champion === "string" &&
    Array.isArray((x as ThisGame).screens) &&
    (x as ThisGame).screens.every(isScreen)
  );
}

function parse<K extends Key>(key: K, raw: string | null): Shape[K] {
  try {
    const value: unknown = raw === null ? null : JSON.parse(raw);
    if (key === "game") return (isGame(value) ? value : null) as Shape[K];
    if (key === "saved") return (Array.isArray(value) ? value.filter(isGame) : []) as Shape[K];
    return (Array.isArray(value) ? value.filter((s): s is string => typeof s === "string") : []) as Shape[K];
  } catch {
    return EMPTY[key];
  }
}

function read<K extends Key>(key: K): Shape[K] {
  if (key in memory) return memory[key] as Shape[K];
  let raw: string | null = null;
  try {
    raw = localStorage.getItem(KEYS[key]);
  } catch {
    // blocked: start empty
  }
  const value = parse(key, raw);
  memory[key] = value;
  return value;
}

function write<K extends Key>(key: K, value: Shape[K]): void {
  memory[key] = value;
  try {
    if (value === null) localStorage.removeItem(KEYS[key]);
    else localStorage.setItem(KEYS[key], JSON.stringify(value));
  } catch {
    // blocked: kept for this visit only
  }
  listeners.forEach((l) => l());
}

function subscribe(listener: () => void): () => void {
  listeners.add(listener);
  const onStorage = (e: StorageEvent) => {
    const key = (Object.keys(KEYS) as Key[]).find((k) => KEYS[k] === e.key);
    if (!key) return;
    delete memory[key];
    listener();
  };
  window.addEventListener("storage", onStorage);
  return () => {
    listeners.delete(listener);
    window.removeEventListener("storage", onStorage);
  };
}

function useKey<K extends Key>(key: K): Shape[K] {
  return useSyncExternalStore(subscribe, () => read(key), () => EMPTY[key]);
}

export const useThisGame = () => useKey("game");
export const useSavedGames = () => useKey("saved");
export const useFollowing = () => useKey("following");

export function setThisGame(game: ThisGame | null): void {
  write("game", game);
}

/** Keep a finished game (newest first, at most SAVED_GAMES_MAX). Empty games aren't kept. */
export function saveGame(game: ThisGame, patch: string, now = new Date()): void {
  if (game.screens.length === 0) return;
  write("saved", [{ ...game, patch, savedAt: now.toISOString() }, ...read("saved")].slice(0, SAVED_GAMES_MAX));
}

export function toggleFollow(slug: string): void {
  const current = read("following");
  write("following", current.includes(slug) ? current.filter((s) => s !== slug) : [...current, slug].slice(-FOLLOWING_MAX));
}

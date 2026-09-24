/**
 * Phase 2 acceptance: the Pick screen works offline. Runs the real public/sw.js
 * in a sandbox with an in-memory Cache API and a switchable network.
 */
import { readFileSync } from "node:fs";
import path from "node:path";
import vm from "node:vm";
import { describe, expect, test, vi } from "vitest";

type Handler = (event: { request: Request; respondWith: (r: Promise<Response>) => void; waitUntil: (p: Promise<unknown>) => void }) => void;

function sandbox() {
  const stores = new Map<string, Map<string, Response>>();
  const key = (r: Request | string, ignoreSearch = false) => {
    const u = new URL(typeof r === "string" ? r : r.url);
    return ignoreSearch ? u.origin + u.pathname : u.href;
  };
  const caches = {
    async keys() {
      return [...stores.keys()];
    },
    async delete(name: string) {
      return stores.delete(name);
    },
    async open(name: string) {
      if (!stores.has(name)) stores.set(name, new Map());
      const store = stores.get(name)!;
      return {
        async match(r: Request, opts?: { ignoreSearch?: boolean }) {
          if (opts?.ignoreSearch) {
            for (const [k, v] of store) if (key(k, true) === key(r, true)) return v.clone();
            return undefined;
          }
          return store.get(key(r))?.clone();
        },
        async put(r: Request, res: Response) {
          store.set(key(r), res);
        },
        async keys() {
          return [...store.keys()].map((k) => new Request(k));
        },
        async delete(r: Request) {
          return store.delete(key(r));
        },
      };
    },
  };
  let online = true;
  let slow = false;
  let served = 0;
  const fetch = async (r: Request) => {
    if (!online) throw new TypeError("offline");
    if (slow) await new Promise((resolve) => setTimeout(resolve, 60_000));
    served++;
    return new Response(`body of ${new URL(r.url).pathname}`, { status: 200 });
  };
  const handlers: Record<string, Handler> = {};
  const self = { location: { origin: "https://wasfun.lol" }, addEventListener: (t: string, h: Handler) => (handlers[t] = h), skipWaiting() {}, clients: { claim: async () => {} } };
  vm.runInNewContext(readFileSync(path.join(process.cwd(), "public/sw.js"), "utf-8"), { self, caches, fetch, URL, Response, console, setTimeout });
  const request = async (url: string, headers: Record<string, string> = {}): Promise<Response | null> => {
    const box: { result: Promise<Response> | null } = { result: null };
    handlers.fetch({ request: new Request(url, { headers }), respondWith: (r) => (box.result = r), waitUntil() {} });
    return box.result ? await box.result : null;
  };
  const activate = async () => {
    let done: Promise<unknown> = Promise.resolve();
    handlers.activate({ request: new Request("https://wasfun.lol/"), respondWith() {}, waitUntil: (p) => (done = p) });
    await done;
  };
  return { request, activate, caches, goOffline: () => (online = false), goSlow: () => (slow = true), served: () => served, stores };
}

describe("the Pick screen works offline", () => {
  test("a Pick page and its assets visited once are served with no network", async () => {
    const sw = sandbox();
    for (const url of ["https://wasfun.lol/pick/yasuo", "https://wasfun.lol/ja/pick/yasuo", "https://wasfun.lol/_next/static/chunks/app.js", "https://wasfun.lol/assets/icons/aug/ARAM_TankEngine.png"]) {
      expect((await sw.request(url))?.status).toBe(200);
    }
    sw.goOffline();
    expect(await (await sw.request("https://wasfun.lol/pick/yasuo"))!.text()).toBe("body of /pick/yasuo");
    expect(await (await sw.request("https://wasfun.lol/ja/pick/yasuo"))!.text()).toBe("body of /ja/pick/yasuo");
    expect((await sw.request("https://wasfun.lol/_next/static/chunks/app.js"))!.status).toBe(200);
    expect((await sw.request("https://wasfun.lol/assets/icons/aug/ARAM_TankEngine.png"))!.status).toBe(200);
  });

  test("online, Pick pages are fetched fresh (network first); other pages are left alone", async () => {
    const sw = sandbox();
    await sw.request("https://wasfun.lol/pick/yasuo");
    await sw.request("https://wasfun.lol/pick/yasuo");
    expect(sw.served()).toBe(2);
    expect(await sw.request("https://wasfun.lol/champions/yasuo")).toBeNull();
  });

  test("router prefetches and RSC requests are not cached as pages", async () => {
    const sw = sandbox();
    expect(await sw.request("https://wasfun.lol/pick/lux", { RSC: "1" })).toBeNull();
    expect(await sw.request("https://wasfun.lol/pick/lux", { "Next-Router-Prefetch": "1" })).toBeNull();
  });

  test("a champion reached by client-side navigation is cached once the screen asks for its page", async () => {
    const sw = sandbox();
    // the router's data request for /pick/ahri passes through uncached
    expect(await sw.request("https://wasfun.lol/pick/ahri", { RSC: "1" })).toBeNull();
    // the Pick screen then requests its own page as a document (PickScreen's mount effect)
    await sw.request("https://wasfun.lol/pick/ahri", { Accept: "text/html" });
    sw.goOffline();
    expect(await (await sw.request("https://wasfun.lol/pick/ahri"))!.text()).toBe("body of /pick/ahri");
    const source = readFileSync(path.join(process.cwd(), "src/components/pick/PickScreen.tsx"), "utf-8");
    expect(source).toContain('fetch(window.location.pathname, { credentials: "same-origin", headers: { Accept: "text/html" } })');
  });

  test("on a slow network the last copy is served after the timeout", async () => {
    vi.useFakeTimers();
    try {
      const sw = sandbox();
      await sw.request("https://wasfun.lol/pick/yasuo");
      sw.goSlow();
      const pending = sw.request("https://wasfun.lol/pick/yasuo");
      await vi.advanceTimersByTimeAsync(4_000);
      expect(await (await pending)!.text()).toBe("body of /pick/yasuo");
    } finally {
      vi.useRealTimers();
    }
  });

  test("activation deletes caches from older versions", async () => {
    const sw = sandbox();
    await (await sw.caches.open("mo-pick-v0")).put(new Request("https://wasfun.lol/pick/a"), new Response("old"));
    await sw.request("https://wasfun.lol/pick/yasuo");
    await sw.activate();
    expect([...sw.stores.keys()]).not.toContain("mo-pick-v0");
    expect([...sw.stores.keys()]).toContain("mo-pick-v1");
  });

  test("build assets are trimmed to the newest", async () => {
    const sw = sandbox();
    for (let i = 0; i < 405; i++) await sw.request(`https://wasfun.lol/_next/static/chunks/${i}.js`);
    await new Promise((r) => setTimeout(r, 50));
    const assets = sw.stores.get("mo-assets-v1")!;
    expect(assets.size).toBe(400);
    expect(assets.has("https://wasfun.lol/_next/static/chunks/0.js")).toBe(false);
  });
});

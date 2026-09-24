/**
 * Phase 2 acceptance: the Pick screen works offline. Runs the real public/sw.js
 * in a sandbox with an in-memory Cache API and a switchable network.
 */
import { readFileSync } from "node:fs";
import path from "node:path";
import vm from "node:vm";
import { describe, expect, test } from "vitest";

type Handler = (event: { request: Request; respondWith: (r: Promise<Response>) => void; waitUntil: (p: Promise<unknown>) => void }) => void;

function sandbox() {
  const stores = new Map<string, Map<string, Response>>();
  const key = (r: Request | string, ignoreSearch = false) => {
    const u = new URL(typeof r === "string" ? r : r.url);
    return ignoreSearch ? u.origin + u.pathname : u.href;
  };
  const caches = {
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
      };
    },
  };
  let online = true;
  let served = 0;
  const fetch = async (r: Request) => {
    if (!online) throw new TypeError("offline");
    served++;
    return new Response(`body of ${new URL(r.url).pathname}`, { status: 200 });
  };
  const handlers: Record<string, Handler> = {};
  const self = { location: { origin: "https://wasfun.lol" }, addEventListener: (t: string, h: Handler) => (handlers[t] = h), skipWaiting() {}, clients: { claim: async () => {} } };
  vm.runInNewContext(readFileSync(path.join(process.cwd(), "public/sw.js"), "utf-8"), { self, caches, fetch, URL, Response, console });
  const request = async (url: string): Promise<Response | null> => {
    const box: { result: Promise<Response> | null } = { result: null };
    handlers.fetch({ request: new Request(url), respondWith: (r) => (box.result = r), waitUntil() {} });
    return box.result ? await box.result : null;
  };
  return { request, goOffline: () => (online = false), served: () => served };
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
});

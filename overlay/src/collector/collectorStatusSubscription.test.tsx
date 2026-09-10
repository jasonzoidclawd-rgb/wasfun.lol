import { act, create, type ReactTestRenderer } from "react-test-renderer";
import { beforeEach, describe, expect, it, vi } from "vitest";

import type { CollectorSnapshot } from "./CollectorStatus";

// react-test-renderer refuses to flush effects inside act() without this.
(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const tauri = vi.hoisted(() => ({
  invoke: vi.fn(),
  listen: vi.fn(),
  unlisten: vi.fn(),
  emit: vi.fn(),
}));

vi.mock("@tauri-apps/api/core", () => ({ invoke: tauri.invoke }));
vi.mock("@tauri-apps/api/event", () => ({
  listen: tauri.listen,
  emit: tauri.emit,
}));
vi.mock("@tauri-apps/api/webviewWindow", () => ({
  WebviewWindow: class MockWebviewWindow {
    static getByLabel() {
      return Promise.resolve(null);
    }
  },
  getCurrentWebviewWindow: () => ({
    close: () => Promise.resolve(),
    label: "collector-controls",
  }),
}));

import { useCollectorStatus } from "./CollectorStatus";

// The Rust side deserializes a fresh object per IPC reply, so `Object.is`
// always fails and React commits even when the status is unchanged. Returning
// one shared object here would hide the defect this file exists to catch.
function freshSnapshot(): CollectorSnapshot {
  return {
    consent: "accepted",
    paused: false,
    activeGame: false,
    exportedToday: 0,
    dailyLimit: 100,
    queuedBatches: 0,
  };
}

// A re-subscribing hook drives an unbounded render loop, and act() can never
// reach quiescence against one. Answering only the first few status commands
// bounds the run so the count is an assertion rather than a timeout.
const ANSWERED_STATUS_REPLIES = 5;

function statusCommandCount() {
  return tauri.invoke.mock.calls.filter(
    ([command]) => command === "get_collector_status",
  ).length;
}

// The shape of the CollectorConsentWindow / CollectorControlsWindow call
// sites: the status callback is omitted entirely.
function OmittedCallbackProbe() {
  useCollectorStatus(undefined, { poll: false });
  return null;
}

describe("useCollectorStatus event subscription", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    let answered = 0;
    tauri.invoke.mockImplementation((command: string) => {
      if (command !== "get_collector_status") {
        return Promise.resolve(freshSnapshot());
      }
      answered += 1;
      if (answered > ANSWERED_STATUS_REPLIES) {
        return new Promise<CollectorSnapshot>(() => {});
      }
      return Promise.resolve(freshSnapshot());
    });
    tauri.listen.mockImplementation(async () => tauri.unlisten);
  });

  it("subscribes once when the status callback is omitted", async () => {
    let renderer: ReactTestRenderer | undefined;
    await act(async () => {
      renderer = create(<OmittedCallbackProbe />);
    });

    expect(tauri.listen).toHaveBeenCalledTimes(1);
    expect(tauri.unlisten).not.toHaveBeenCalled();

    await act(async () => {
      renderer?.unmount();
    });
  });

  it("does not re-invoke the status command on every commit", async () => {
    await act(async () => {
      create(<OmittedCallbackProbe />);
    });

    expect(statusCommandCount()).toBe(1);
  });
});

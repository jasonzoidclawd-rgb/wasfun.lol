import React from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, create } from "react-test-renderer";

globalThis.IS_REACT_ACT_ENVIRONMENT = true;

const invokeMock = vi.fn();
const listenMock = vi.fn();
const openCollectorControlsWindowMock = vi.fn();
const openConsentWindowMock = vi.fn();
const closeWindowMock = vi.fn();
const publishCollectorStatusMock = vi.fn();

vi.mock("@tauri-apps/api/core", () => ({
  invoke: (...args) => invokeMock(...args),
}));

vi.mock("@tauri-apps/api/event", () => ({
  listen: (...args) => listenMock(...args),
}));

vi.mock("./collectorWindows", async (importOriginal) => {
  const actual = await importOriginal();
  return {
    ...actual,
    closeWindow: (...args) => closeWindowMock(...args),
    openCollectorControlsWindow: (...args) => openCollectorControlsWindowMock(...args),
    openConsentWindow: (...args) => openConsentWindowMock(...args),
    publishCollectorStatus: (...args) => publishCollectorStatusMock(...args),
  };
});

import { CollectorOverlayController } from "./CollectorStatus";
import {
  COLLECTOR_CONTROLS_WINDOW_LABEL,
  COLLECTOR_STATUS_EVENT,
  CONSENT_WINDOW_LABEL,
} from "./collectorWindows";

function snapshot(overrides = {}) {
  return {
    consent: "accepted",
    paused: false,
    activeGame: false,
    exportedToday: 3,
    dailyLimit: 100,
    queuedBatches: 2,
    ...overrides,
  };
}

async function flush() {
  await Promise.resolve();
  await Promise.resolve();
}

describe("CollectorOverlayController", () => {
  let currentStatus;
  let statusListener;
  let root;

  beforeEach(() => {
    vi.useFakeTimers();
    currentStatus = snapshot();
    statusListener = undefined;

    invokeMock.mockImplementation(async () => currentStatus);
    listenMock.mockImplementation(async (eventName, callback) => {
      if (eventName === COLLECTOR_STATUS_EVENT) statusListener = callback;
      return () => {
        statusListener = undefined;
      };
    });
  });

  afterEach(async () => {
    if (root) {
      await act(async () => {
        root.unmount();
        await flush();
      });
      root = undefined;
    }
    vi.useRealTimers();
    vi.clearAllMocks();
  });

  it("keeps collector state alive while the panel hides on blur and restores it on refocus", async () => {
    const onStatus = vi.fn();

    await act(async () => {
      root = create(
        React.createElement(CollectorOverlayController, {
          onStatus,
          showPanel: true,
        }),
      );
      await flush();
    });

    expect(openCollectorControlsWindowMock).toHaveBeenCalledTimes(1);
    expect(closeWindowMock).toHaveBeenCalledWith(CONSENT_WINDOW_LABEL);
    expect(onStatus).toHaveBeenLastCalledWith(
      expect.objectContaining({
        paused: false,
        queuedBatches: 2,
      }),
    );

    currentStatus = snapshot({
      paused: true,
      queuedBatches: 7,
      lastError: "collector-backlog",
    });

    await act(async () => {
      await statusListener?.({ payload: currentStatus });
      await flush();
    });

    expect(onStatus).toHaveBeenLastCalledWith(
      expect.objectContaining({
        paused: true,
        queuedBatches: 7,
        lastError: "collector-backlog",
      }),
    );

    await act(async () => {
      root.update(
        React.createElement(CollectorOverlayController, {
          onStatus,
          showPanel: false,
        }),
      );
      await flush();
    });

    expect(closeWindowMock).toHaveBeenCalledWith(COLLECTOR_CONTROLS_WINDOW_LABEL);
    const closeCountAfterBlur = closeWindowMock.mock.calls.filter(
      ([label]) => label === COLLECTOR_CONTROLS_WINDOW_LABEL,
    ).length;

    await act(async () => {
      await vi.advanceTimersByTimeAsync(15_000);
      await flush();
    });

    expect(
      invokeMock.mock.calls.filter(([command]) => command === "collector_tick").length,
    ).toBe(3);
    expect(publishCollectorStatusMock).toHaveBeenCalled();
    expect(
      closeWindowMock.mock.calls.filter(([label]) => label === COLLECTOR_CONTROLS_WINDOW_LABEL)
        .length,
    ).toBe(closeCountAfterBlur);
    expect(openCollectorControlsWindowMock).toHaveBeenCalledTimes(1);

    await act(async () => {
      root.update(
        React.createElement(CollectorOverlayController, {
          onStatus,
          showPanel: true,
        }),
      );
      await flush();
    });

    expect(openCollectorControlsWindowMock).toHaveBeenCalledTimes(2);
    expect(onStatus).toHaveBeenLastCalledWith(
      expect.objectContaining({
        paused: true,
        queuedBatches: 7,
        lastError: "collector-backlog",
      }),
    );

    const ticksBeforeFocusToggles = invokeMock.mock.calls.filter(
      ([command]) => command === "collector_tick",
    ).length;
    const closeCountBeforeFocusToggles = closeWindowMock.mock.calls.filter(
      ([label]) => label === COLLECTOR_CONTROLS_WINDOW_LABEL,
    ).length;
    for (const showPanel of [false, true, false, true]) {
      await act(async () => {
        root.update(
          React.createElement(CollectorOverlayController, {
            onStatus,
            showPanel,
          }),
        );
        await flush();
      });
    }

    expect(
      invokeMock.mock.calls.filter(([command]) => command === "collector_tick").length,
    ).toBe(ticksBeforeFocusToggles);
    expect(openCollectorControlsWindowMock).toHaveBeenCalledTimes(4);
    expect(
      closeWindowMock.mock.calls.filter(([label]) => label === COLLECTOR_CONTROLS_WINDOW_LABEL)
        .length,
    ).toBe(closeCountBeforeFocusToggles + 2);
  });

  it("closes stale native controls on the initial unfocused render", async () => {
    await act(async () => {
      root = create(
        React.createElement(CollectorOverlayController, {
          onStatus: vi.fn(),
          showPanel: false,
        }),
      );
      await flush();
    });

    expect(closeWindowMock).toHaveBeenCalledWith(COLLECTOR_CONTROLS_WINDOW_LABEL);
    expect(openCollectorControlsWindowMock).not.toHaveBeenCalled();
  });
});

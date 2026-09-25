import { useCallback, useEffect, useRef, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import {
  closeCurrentWindow,
  closeWindow,
  COLLECTOR_CONTROLS_WINDOW_LABEL,
  COLLECTOR_STATUS_EVENT,
  CONSENT_WINDOW_LABEL,
  openCollectorControlsWindow,
  openConsentWindow,
  publishCollectorStatus,
  resolveCollectorWindowVisibility,
} from "./collectorWindows";

export type CollectorConsent = "pending" | "accepted" | "declined";

export interface CollectorSnapshot {
  consent: CollectorConsent;
  paused: boolean;
  activeGame: boolean;
  exportedToday: number;
  dailyLimit: number;
  queuedBatches: number;
  lastError?: string;
}

interface CollectorStatusProps {
  onStatus: (status: CollectorSnapshot) => void;
}

interface CollectorOverlayControllerProps extends CollectorStatusProps {
  showPanel?: boolean;
}

interface CollectorStatusOptions {
  poll?: boolean;
  publishRefreshes?: boolean;
}

// A `() => {}` written inline as the default is re-evaluated on every call,
// so callers that omit `onStatus` get a new identity per render. That
// destabilises `applyStatus` and makes both effects below re-run on every
// commit, re-subscribing the event listener each time.
const IGNORE_STATUS = () => {};

export function useCollectorStatus(
  onStatus: (status: CollectorSnapshot) => void = IGNORE_STATUS,
  {
    poll = true,
    publishRefreshes = false,
  }: CollectorStatusOptions = {},
) {
  const [status, setStatus] = useState<CollectorSnapshot | null>(null);

  const applyStatus = useCallback((next: CollectorSnapshot) => {
    setStatus(next);
    onStatus(next);
  }, [onStatus]);

  useEffect(() => {
    let cancelled = false;
    let running = false;

    const refresh = async (tick: boolean) => {
      if (running) return;
      running = true;
      try {
        const next = await invoke<CollectorSnapshot>(
          tick ? "collector_tick" : "get_collector_status",
        );
        if (!cancelled) {
          applyStatus(next);
          if (publishRefreshes) void publishCollectorStatus(next);
        }
      } finally {
        running = false;
      }
    };

    void refresh(false);
    if (!poll) {
      return () => {
        cancelled = true;
      };
    }
    const interval = setInterval(() => void refresh(true), 5_000);
    return () => {
      cancelled = true;
      clearInterval(interval);
    };
  }, [applyStatus, poll, publishRefreshes]);

  useEffect(() => {
    let disposed = false;
    let unlisten: (() => void) | null = null;

    void listen<CollectorSnapshot>(COLLECTOR_STATUS_EVENT, (event) => {
      applyStatus(event.payload);
    }).then((nextUnlisten) => {
      if (disposed) {
        nextUnlisten();
        return;
      }
      unlisten = nextUnlisten;
    });

    return () => {
      disposed = true;
      unlisten?.();
    };
  }, [applyStatus]);

  const setConsent = useCallback(async (accepted: boolean) => {
    const next = await invoke<CollectorSnapshot>("set_collector_consent", { accepted });
    applyStatus(next);
    await publishCollectorStatus(next);
    return next;
  }, [applyStatus]);

  const setPaused = useCallback(async (paused: boolean) => {
    const next = await invoke<CollectorSnapshot>("set_collector_paused", { paused });
    applyStatus(next);
    await publishCollectorStatus(next);
    return next;
  }, [applyStatus]);

  return {
    status,
    setConsent,
    setPaused,
  };
}

interface CollectorConsentPromptProps {
  disabled?: boolean;
  onChoice: (accepted: boolean) => void;
}

export function CollectorConsentPrompt({
  disabled = false,
  onChoice,
}: CollectorConsentPromptProps) {
  return (
    <section className="collector-consent" role="dialog" aria-modal="true">
      <strong>Help improve Mayhem Oracle?</strong>
      <p>
        The collector uploads only de-identified Mayhem match fields. Riot IDs,
        PUUIDs, names, chat, and screenshots never leave this device.
      </p>
      <p>Declining disables both collection and the overlay.</p>
      <div className="collector-actions">
        <button disabled={disabled} onClick={() => onChoice(true)}>Allow and continue</button>
        <button className="secondary" disabled={disabled} onClick={() => onChoice(false)}>
          Decline
        </button>
      </div>
    </section>
  );
}

interface CollectorControlsProps {
  status: CollectorSnapshot | null;
  onConsent: (accepted: boolean) => void;
  onPaused: (paused: boolean) => void;
}

export function CollectorControls({
  status,
  onConsent,
  onPaused,
}: CollectorControlsProps) {
  if (!status || status.consent === "pending") return null;

  if (status.consent === "declined") {
    return (
      <section className="collector-panel">
        <strong>Collector and overlay disabled</strong>
        <button onClick={() => onConsent(true)}>Enable</button>
      </section>
    );
  }

  return (
    <section className="collector-panel">
      <div className="collector-heading">
        <strong>Free collector</strong>
        <span>{status.activeGame ? "Paused in active game" : status.paused ? "Paused" : "Collecting"}</span>
      </div>
      <div className="collector-progress">
        <span>{status.exportedToday}/{status.dailyLimit} today</span>
        <span>{status.queuedBatches} queued</span>
      </div>
      {status.lastError && <span className="collector-error">{status.lastError}</span>}
      <button onClick={() => onPaused(!status.paused)}>
        {status.paused ? "Resume" : "Pause"}
      </button>
    </section>
  );
}

export function CollectorStatus({ onStatus }: CollectorStatusProps) {
  const { status, setConsent, setPaused } = useCollectorStatus(onStatus);

  if (!status || status.consent === "pending") {
    return (
      <CollectorConsentPrompt
        onChoice={(accepted) => void setConsent(accepted)}
      />
    );
  }

  return (
    <CollectorControls
      status={status}
      onConsent={(accepted) => void setConsent(accepted)}
      onPaused={(paused) => void setPaused(paused)}
    />
  );
}

export function CollectorOverlayController({
  onStatus,
  showPanel = true,
}: CollectorOverlayControllerProps) {
  const { status } = useCollectorStatus(onStatus, {
    poll: true,
    publishRefreshes: true,
  });
  const visibleWindowsRef = useRef<{
    consentWindow: boolean;
    collectorControlsWindow: boolean;
  } | null>(null);

  useEffect(() => {
    const nextVisibility = resolveCollectorWindowVisibility({
      status,
      controlsVisible: showPanel,
    });
    const previousVisibility = visibleWindowsRef.current;
    visibleWindowsRef.current = nextVisibility;

    if (nextVisibility.consentWindow && previousVisibility?.consentWindow !== true) {
      void openConsentWindow();
    } else if (!nextVisibility.consentWindow && (
      previousVisibility === null || previousVisibility.consentWindow
    )) {
      // Close on the initial hidden render too. A stale native window can
      // survive an overlay restart while League/Riot Client is foreground.
      void closeWindow(CONSENT_WINDOW_LABEL);
    }

    if (nextVisibility.collectorControlsWindow && previousVisibility?.collectorControlsWindow !== true) {
      void openCollectorControlsWindow();
    } else if (!nextVisibility.collectorControlsWindow && (
      previousVisibility === null || previousVisibility.collectorControlsWindow
    )) {
      // The first status refresh must also close a previously opened controls
      // window; no controller state is unmounted or reset here.
      void closeWindow(COLLECTOR_CONTROLS_WINDOW_LABEL);
    }

  }, [showPanel, status]);

  return null;
}

export function CollectorConsentWindow() {
  const { status, setConsent } = useCollectorStatus(undefined, { poll: false });
  const [closing, setClosing] = useState(false);
  const closeRequested = useRef(false);

  useEffect(() => {
    if (!closeRequested.current && status && status.consent !== "pending") {
      closeRequested.current = true;
      void closeCurrentWindow();
    }
  }, [status]);

  const choose = async (accepted: boolean) => {
    setClosing(true);
    try {
      await setConsent(accepted);
    } finally {
      await closeCurrentWindow();
    }
  };

  if (closing) return null;

  return (
    <main className="consent-window-root">
      <CollectorConsentPrompt
        disabled={!status}
        onChoice={(accepted) => void choose(accepted)}
      />
    </main>
  );
}

export function CollectorControlsWindow() {
  const { status, setConsent, setPaused } = useCollectorStatus(undefined, { poll: false });

  useEffect(() => {
    if (status?.consent === "pending") {
      void closeCurrentWindow();
    }
  }, [status]);

  return (
    <main className="collector-window-root">
      <CollectorControls
        status={status}
        onConsent={(accepted) => void setConsent(accepted)}
        onPaused={(paused) => void setPaused(paused)}
      />
    </main>
  );
}

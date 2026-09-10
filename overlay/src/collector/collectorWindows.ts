import { emit } from "@tauri-apps/api/event";
import { WebviewWindow, getCurrentWebviewWindow } from "@tauri-apps/api/webviewWindow";
import type { CollectorSnapshot } from "./CollectorStatus";

export const OVERLAY_WINDOW_LABEL = "overlay";
export const CONSENT_WINDOW_LABEL = "consent";
export const COLLECTOR_CONTROLS_WINDOW_LABEL = "collector-controls";
export const COLLECTOR_STATUS_EVENT = "collector-status";

export const CONSENT_WINDOW_OPTIONS = {
  url: "/?window=consent",
  title: "Mayhem Oracle Consent",
  width: 460,
  height: 340,
  minWidth: 380,
  minHeight: 300,
  center: true,
  resizable: false,
  decorations: true,
  transparent: false,
  fullscreen: false,
  alwaysOnTop: false,
  skipTaskbar: false,
  focus: true,
  focusable: true,
  visible: true,
} as const;

export const COLLECTOR_CONTROLS_WINDOW_OPTIONS = {
  url: "/?window=collector-controls",
  title: "Mayhem Oracle Collector",
  width: 260,
  height: 172,
  minWidth: 240,
  minHeight: 140,
  resizable: false,
  decorations: false,
  transparent: true,
  fullscreen: false,
  alwaysOnTop: true,
  skipTaskbar: true,
  focus: false,
  focusable: true,
  visible: true,
} as const;

const pendingWindowCreates = new Set<string>();

export function currentWindowLabel(): string {
  try {
    return getCurrentWebviewWindow().label;
  } catch {
    return OVERLAY_WINDOW_LABEL;
  }
}

export function shouldShowConsentWindow(status: CollectorSnapshot | null): boolean {
  return status?.consent === "pending";
}

export function shouldShowCollectorControlsWindow(status: CollectorSnapshot | null): boolean {
  return status !== null && status.consent !== "pending";
}

export function resolveCollectorWindowVisibility({
  status,
  controlsVisible,
}: {
  status: CollectorSnapshot | null;
  controlsVisible: boolean;
}): {
  consentWindow: boolean;
  collectorControlsWindow: boolean;
} {
  return {
    consentWindow: shouldShowConsentWindow(status) && controlsVisible,
    collectorControlsWindow:
      shouldShowCollectorControlsWindow(status) && controlsVisible,
  };
}

export function overlayShouldIgnoreMouseEvents({
  coachOpen,
}: {
  coachOpen: boolean;
}): boolean {
  return !coachOpen;
}

async function ensureWindow(label: string, options: ConstructorParameters<typeof WebviewWindow>[1]) {
  if (pendingWindowCreates.has(label)) return;
  if (await WebviewWindow.getByLabel(label)) return;
  pendingWindowCreates.add(label);
  const window = new WebviewWindow(label, options);
  await Promise.race([
    window.once("tauri://created", () => {
      pendingWindowCreates.delete(label);
    }),
    window.once("tauri://error", () => {
      pendingWindowCreates.delete(label);
    }),
  ]);
}

export async function openConsentWindow() {
  await ensureWindow(CONSENT_WINDOW_LABEL, CONSENT_WINDOW_OPTIONS);
}

export async function openCollectorControlsWindow() {
  await ensureWindow(COLLECTOR_CONTROLS_WINDOW_LABEL, COLLECTOR_CONTROLS_WINDOW_OPTIONS);
}

export async function closeWindow(label: string) {
  const window = await WebviewWindow.getByLabel(label);
  if (!window) return;
  await window.hide().catch(() => {});
  await window.close().catch(() => {});
}

export async function closeCurrentWindow() {
  await getCurrentWebviewWindow().close();
}

export async function publishCollectorStatus(status: CollectorSnapshot) {
  await emit(COLLECTOR_STATUS_EVENT, status);
}

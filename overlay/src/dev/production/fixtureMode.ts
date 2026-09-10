export type OverlayPhase = "idle" | "client_found" | "in_game" | "augment_selection";

export type OverlayFixtureMode =
  | { kind: "real-offer" }
  | { kind: "ocr-unavailable" }
  | { kind: "preview" }
  | { kind: "hidden" };

export function isGeometryPreviewEnabled(): boolean {
  return false;
}

export function resolveOverlayFixtureMode(_input: {
  tierFixtureOn: boolean;
  previewOn: boolean;
  gameWindowForeground: boolean;
  phase: OverlayPhase;
  offerActive: boolean;
  aramggReady: boolean;
}): OverlayFixtureMode {
  void _input;
  return { kind: "hidden" };
}

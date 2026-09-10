import { describe, expect, it } from "vitest";
import {
  advanceGeometrySurface,
  buildGeometryVisibleFrame,
  createGeometrySurfaceState,
  identityForSlot,
  newOfferDetected,
  type GeometryObservation,
  type GeometrySurfaceState,
  type IdentityRecord,
} from "./surfaceGeometry";
import {
  advanceOfferSurface,
  createOfferSurfaceState,
  type OfferSurfaceState,
} from "./offerSurfaceState";
import { applyRerollInvalidation } from "./rerollInvalidation";
import { visibleFrameRenderable, type VisibleOfferFrame } from "./visibleOfferFrame";

// ── Fixtures ────────────────────────────────────────────────────────────────
// A 144-bit average-hash where each augment id sets a disjoint 16-bit window, so
// distinct augments differ by ≥16 bits (well past FINGERPRINT_CHANGED_HAMMING=8)
// and identical augments differ by 0. This lets the sequence model reroll vs.
// repeated-card offers deterministically without pixels.
function fp(id: number): string {
  const bits = Array(144).fill("0");
  for (let i = 0; i < 16; i += 1) bits[(id * 16 + i) % 144] = "1";
  return bits.join("");
}

function presentObs(
  seq: number,
  now: number,
  ids: [number, number, number],
): GeometryObservation {
  return {
    probeSeq: seq,
    capturedAt: now,
    captureWidth: 1280,
    captureHeight: 720,
    present: true,
    occluded: false,
    confidence: 0.8,
    blueControl: {
      present: true,
      confidence: 0.8,
      normalizedRect: { x: 0.435, y: 0.758, width: 0.13, height: 0.067 },
    },
    cards: ids.map((id, regionIndex) => ({
      regionIndex,
      present: true,
      cardRect: { x: 280 + regionIndex * 250, y: 250, width: 220, height: 60 },
      interiorLuma: 13,
      interiorStd: 1,
      frameContrast: 100,
      edgeEnergy: 14,
      structuralScore: 0.8,
      fingerprint: fp(id),
    })),
    rejectionReasons: [],
    preCaptureMs: 0,
    captureMs: 0,
    analysisMs: 0,
    elapsedMs: 0,
  };
}

// A valid capture that shows zero cards (a genuine no-offer / gameplay frame):
// capture succeeded (dimensions > 0) so it classifies "absent", never uncertain.
function absentObs(seq: number, now: number): GeometryObservation {
  return {
    probeSeq: seq,
    capturedAt: now,
    captureWidth: 1280,
    captureHeight: 720,
    present: false,
    occluded: false,
    confidence: 0,
    blueControl: {
      present: false,
      confidence: 0,
      normalizedRect: { x: 0.435, y: 0.758, width: 0.13, height: 0.067 },
    },
    cards: [0, 1, 2].map((regionIndex) => ({
      regionIndex,
      present: false,
      cardRect: null,
      interiorLuma: 60,
      interiorStd: 20,
      frameContrast: 5,
      edgeEnergy: 30,
      structuralScore: 0,
      fingerprint: "",
    })),
    rejectionReasons: ["insufficient-cards-0/3"],
    preCaptureMs: 0,
    captureMs: 0,
    analysisMs: 0,
    elapsedMs: 0,
  };
}

// An invalid capture is uncertainty, not authoritative evidence that the
// visible offer closed. It may preserve the current visual state only until
// the independent geometry-freshness deadline expires.
function captureFailureObs(seq: number, now: number): GeometryObservation {
  return {
    ...absentObs(seq, now),
    captureWidth: 0,
    captureHeight: 0,
    rejectionReasons: ["capture-timeout"],
  };
}

// ── Faithful App publication harness ────────────────────────────────────────
// Mirrors runGeometryProbe's composition (App.tsx 1558-1705): advanceGeometry →
// newOfferDetected → advanceOfferSurface → NO_OFFER reset → reroll invalidation →
// republishGeometryFrame. Every step calls the REAL exported reducers; only the
// React refs are modeled locally.
class PublicationHarness {
  geom: GeometrySurfaceState = createGeometrySurfaceState();
  offer: OfferSurfaceState = createOfferSurfaceState();
  geometryGeneration = 0;
  identityStore: Array<IdentityRecord<string> | null> = [null, null, null];
  acceptedFingerprints = ["", "", ""];
  slotGenerations = [0, 0, 0];
  revision = 0;
  visibleFrame: VisibleOfferFrame<string> | null = null;
  foreground = true;

  probe(obs: GeometryObservation, now: number): void {
    const prevGeom = this.geom;
    const transition = advanceGeometrySurface(prevGeom, obs);
    this.geom = transition.state;

    const geometryObservation =
      transition.action === "preserve"
        ? prevGeom.visualObservation
        : transition.action === "publish"
          ? transition.state.visualObservation
          : obs;

    const publishedObservation = transition.state.visualObservation;
    const detectedNewOffer =
      transition.action === "publish" &&
      publishedObservation != null &&
      newOfferDetected(prevGeom.lastPositiveObservation, publishedObservation);

    const priorOffer = this.offer;
    const effectiveObservation = publishedObservation ?? obs;
    const nextOffer = advanceOfferSurface(priorOffer, {
      now,
      captureValid: obs.captureWidth > 0 && obs.captureHeight > 0,
      blueControlPresent: effectiveObservation.blueControl?.present === true,
      blueControlConfidence: effectiveObservation.blueControl?.confidence ?? 0,
      validCardCount: effectiveObservation.cards.filter((c) => c.present).length,
      occlusionReason: obs.occluded ? "opaque-surface" : null,
      hiddenEvidence: false,
      newOfferEvidence: detectedNewOffer,
    });
    this.offer = nextOffer;
    this.geometryGeneration = nextOffer.offerGeneration;

    if (nextOffer.state === "NO_OFFER" && priorOffer.state !== "NO_OFFER") {
      this.identityStore = [null, null, null];
      this.acceptedFingerprints = ["", "", ""];
      this.slotGenerations = this.slotGenerations.map((g) => g + 1);
    }

    if (transition.action === "publish" && publishedObservation != null) {
      const reroll = applyRerollInvalidation({
        store: this.identityStore,
        acceptedFingerprints: this.acceptedFingerprints,
        slotGenerations: this.slotGenerations,
        observation: publishedObservation,
        championGeneration: 0,
        now,
        newOffer: detectedNewOffer,
      });
      this.identityStore = reroll.store;
      this.slotGenerations = reroll.slotGenerations;
      this.acceptedFingerprints = reroll.acceptedFingerprints;
    }

    if (geometryObservation != null) {
      this.visibleFrame = buildGeometryVisibleFrame<string>({
        revision: (this.revision += 1),
        captureSeq: obs.probeSeq,
        observation: geometryObservation,
        generation: this.geometryGeneration,
        resolveIdentity: (region) =>
          identityForSlot(this.identityStore[region], this.slotGenerations[region] ?? 0),
      });
    } else {
      this.visibleFrame = null;
    }
  }

  /** Simulate the OCR track resolving every present slot to a champion badge. */
  resolveAllIdentities(obs: GeometryObservation, now: number): void {
    this.identityStore = obs.cards.map((card, i) =>
      card.present
        ? {
            fingerprint: card.fingerprint,
            resolution: `badge:${card.fingerprint.indexOf("1")}`,
            resolvedAt: now,
            // A publication is stamped with the generation it was read under.
            slotGeneration: this.slotGenerations[i] ?? 0,
          }
        : this.identityStore[i],
    );
  }

  renderable(): boolean {
    return visibleFrameRenderable(this.visibleFrame, this.foreground) && this.offer.render;
  }

  /** SCANNING slots = present rects with a null resolution. */
  scanningCount(): number {
    if (!this.visibleFrame) return 0;
    return this.visibleFrame.slots.filter(
      (s) => s.cardRect !== null && s.resolution === null,
    ).length;
  }

  resolvedCount(): number {
    if (!this.visibleFrame) return 0;
    return this.visibleFrame.slots.filter((s) => s.resolution !== null).length;
  }
}

describe("later-round offer lifecycle (geometry publication path)", () => {
  it("four sequential offers with clean gaps each re-arm, render, and increment generation", () => {
    const h = new PublicationHarness();
    let t = 0;
    let seq = 0;
    const offers: Array<[number, number, number]> = [
      [1, 2, 3],
      [4, 5, 6],
      [7, 8, 9],
      [10, 11, 12],
    ];
    const generations: number[] = [];
    for (const ids of offers) {
      // Offer becomes visible.
      h.probe(presentObs((seq += 1), (t += 150), ids), t);
      expect(h.renderable()).toBe(true);
      expect(h.scanningCount()).toBe(3); // immediately SCANNING, never blank
      generations.push(h.offer.offerGeneration);

      // OCR resolves; badges show.
      h.resolveAllIdentities(presentObs(seq, t, ids), t);
      h.probe(presentObs((seq += 1), (t += 150), ids), t);
      expect(h.resolvedCount()).toBe(3);

      // Selection closes: one fresh valid zero-card frame is authoritative.
      h.probe(absentObs((seq += 1), (t += 150)), t);
      expect(h.offer.render).toBe(false);
    }

    // Every offer got its own strictly-increasing generation — no max-offer cap.
    expect(generations).toHaveLength(4);
    for (let i = 1; i < generations.length; i += 1) {
      expect(generations[i]).toBeGreaterThan(generations[i - 1]);
    }
  });

  it("a queued death-sequence offer delivered through a genuine close starts a fresh session even when it repeats cards", () => {
    // ARAM death-sequence delivery: pick R(n) → the augment UI actually closes
    // (a fresh valid zero-card frame → clear) → R(n+1) opens. Even if the new
    // round REPEATS two augments, the genuine close (not card novelty) mints the
    // fresh session, so ownership/generation advance and every slot re-scans.
    const h = new PublicationHarness();
    let t = 0;
    let seq = 0;

    const roundN: [number, number, number] = [1, 2, 3];
    h.probe(presentObs((seq += 1), (t += 150), roundN), t);
    h.resolveAllIdentities(presentObs(seq, t, roundN), t);
    h.probe(presentObs((seq += 1), (t += 150), roundN), t);
    expect(h.resolvedCount()).toBe(3);
    const genN = h.offer.offerGeneration;

    // Genuine close: a fresh valid zero-card frame ends the session.
    h.probe(absentObs((seq += 1), (t += 150)), t);
    expect(h.offer.render).toBe(false);

    // R(n+1) opens, repeating augments 1 and 2; only slot 2 is a new augment.
    h.probe(presentObs((seq += 1), (t += 150), [1, 2, 99]), t);

    expect(h.renderable()).toBe(true);
    expect(h.offer.offerGeneration).toBeGreaterThan(genN); // fresh session
    // A fresh session re-scans every slot: no chip carries over across a close.
    expect(h.resolvedCount()).toBe(0);
    expect(h.scanningCount()).toBe(3);
  });

  it("an identical A/B/C offer after a clean close re-arms without Hamming novelty", () => {
    const h = new PublicationHarness();
    let t = 0;
    let seq = 0;
    const ids: [number, number, number] = [1, 2, 3];

    h.probe(presentObs((seq += 1), (t += 150), ids), t);
    h.resolveAllIdentities(presentObs(seq, t, ids), t);
    h.probe(presentObs((seq += 1), (t += 150), ids), t);
    const gen1 = h.offer.offerGeneration;

    // Clean close: one fresh valid zero-card frame.
    h.probe(absentObs((seq += 1), (t += 150)), t);

    // The SAME three augments appear again (identical fingerprints).
    h.probe(presentObs((seq += 1), (t += 150), ids), t);
    expect(h.renderable()).toBe(true);
    expect(h.offer.offerGeneration).toBeGreaterThan(gen1);
    expect(h.scanningCount()).toBe(3);
    expect(h.resolvedCount()).toBe(0);
  });

  it("a transient preserved negative followed by a one-slot reroll stays the SAME session (no false new-offer)", () => {
    // Regression guard: a single dropped/transient geometry frame that
    // negative-continuity preserves is NOT proof a round closed. If it coincides
    // with an in-session one-slot reroll (A/B/C → · → A/D/C), the session must be
    // unchanged — same offer generation, ONLY the changed slot invalidated, and
    // the unchanged neighbours keep their existing publications.
    const h = new PublicationHarness();
    let t = 0;
    let seq = 0;

    // A/B/C latched and fully resolved.
    const abc: [number, number, number] = [1, 2, 3];
    h.probe(presentObs((seq += 1), (t += 150), abc), t);
    h.resolveAllIdentities(presentObs(seq, t, abc), t);
    h.probe(presentObs((seq += 1), (t += 150), abc), t);
    expect(h.resolvedCount()).toBe(3);
    const gen = h.offer.offerGeneration;
    const slot0Before = h.visibleFrame?.slots.find((s) => s.regionIndex === 0)?.resolution;
    const slot2Before = h.visibleFrame?.slots.find((s) => s.regionIndex === 2)?.resolution;

    // One transient invalid capture — uncertainty is not proof the offer
    // closed, so the session remains intact inside the freshness bound.
    h.probe(captureFailureObs((seq += 1), (t += 150)), t);

    // Slot 1 rerolls in place: A/D/C.
    h.probe(presentObs((seq += 1), (t += 150), [1, 99, 3]), t);

    // Same offer session — no fresh generation.
    expect(h.offer.offerGeneration).toBe(gen);
    // Only slot 1 was invalidated; neighbours retained their publications.
    const slot0After = h.visibleFrame?.slots.find((s) => s.regionIndex === 0)?.resolution;
    const slot1After = h.visibleFrame?.slots.find((s) => s.regionIndex === 1)?.resolution;
    const slot2After = h.visibleFrame?.slots.find((s) => s.regionIndex === 2)?.resolution;
    expect(slot1After).toBeNull();
    expect(slot0After).toBe(slot0Before);
    expect(slot2After).toBe(slot2Before);
    expect(slot0After).not.toBeNull();
    expect(slot2After).not.toBeNull();
  });

  it("a stale identity keyed to a previous card cannot paint the new card", () => {
    const h = new PublicationHarness();
    let t = 0;
    let seq = 0;

    h.probe(presentObs((seq += 1), (t += 150), [1, 2, 3]), t);
    h.resolveAllIdentities(presentObs(seq, t, [1, 2, 3]), t);
    h.probe(presentObs((seq += 1), (t += 150), [1, 2, 3]), t);
    expect(h.resolvedCount()).toBe(3);

    // Slot 0 rerolls to a different augment; its stale identity must not render.
    h.probe(presentObs((seq += 1), (t += 150), [50, 2, 3]), t);
    const slot0 = h.visibleFrame?.slots.find((s) => s.regionIndex === 0);
    expect(slot0?.resolution).toBeNull();
  });

  it("a later different offer cannot inherit badges from the prior offer", () => {
    const h = new PublicationHarness();
    let t = 0;
    let seq = 0;

    h.probe(presentObs((seq += 1), (t += 150), [1, 2, 3]), t);
    h.resolveAllIdentities(presentObs(seq, t, [1, 2, 3]), t);
    h.probe(presentObs((seq += 1), (t += 150), [1, 2, 3]), t);
    const oldGeneration = h.offer.offerGeneration;
    expect(h.resolvedCount()).toBe(3);

    // Two changed slots are strong new-offer evidence even without a visible
    // gap. The fresh generation invalidates all prior slot publications.
    h.probe(presentObs((seq += 1), (t += 150), [50, 51, 3]), t);
    expect(h.offer.offerGeneration).toBeGreaterThan(oldGeneration);
    expect(h.resolvedCount()).toBe(0);
    expect(h.scanningCount()).toBe(3);
  });

  it("a fresh valid zero-card frame removes all terrain output immediately", () => {
    const h = new PublicationHarness();
    let t = 0;
    let seq = 0;

    h.probe(presentObs((seq += 1), (t += 150), [1, 2, 3]), t);
    h.resolveAllIdentities(presentObs(seq, t, [1, 2, 3]), t);
    h.probe(presentObs((seq += 1), (t += 150), [1, 2, 3]), t);
    expect(h.resolvedCount()).toBe(3);

    h.probe(absentObs((seq += 1), (t += 150)), t);
    expect(h.renderable()).toBe(false);
    expect(h.visibleFrame?.slots).toEqual([]);
    expect(h.resolvedCount()).toBe(0);
    expect(h.scanningCount()).toBe(0);
  });
});

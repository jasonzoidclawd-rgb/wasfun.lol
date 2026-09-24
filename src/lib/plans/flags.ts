/**
 * v3 money flags. Each is off unless its variable is exactly "on", and
 * production leaves them unset: taking payments, the paid-tier path and moving
 * existing members wait on the owner. `NEXT_PUBLIC_` names are written out in
 * full so Next.js can inline them in client code.
 */
const on = (value: string | undefined): boolean => value === "on";

/** The Plans page (/plans) and the one quiet plan line on Home. */
export const plansEnabled = (): boolean => on(process.env.NEXT_PUBLIC_WASFUN_PLANS);

/** The v3 ad placements outside the Pick screen (the ads themselves also need NEXT_PUBLIC_ADS_ENABLED and consent). */
export const v3AdsEnabled = (): boolean => on(process.env.NEXT_PUBLIC_WASFUN_V3_ADS);

/** The overlay download link on /overlay. */
export const overlayDownloadEnabled = (): boolean => on(process.env.NEXT_PUBLIC_WASFUN_OVERLAY_DOWNLOAD);

/** Member extras on the Pick screen (reroll odds); This game, Following and history are not built yet. */
export const memberPickEnabled = (): boolean => on(process.env.NEXT_PUBLIC_WASFUN_MEMBER_PICK);

/**
 * Compact win-rate formatting — exact string/integer arithmetic end-to-end.
 *
 * ARAMGG supplies win rates as fractional decimal STRINGS ("0.5915"). The
 * chip shows one half-up-rounded decimal ("59.2%"): shift the decimal point
 * two places on the digits themselves, then round on digit comparison with a
 * string carry. `Number(value) * 100` / `toFixed(1)` are banned — IEEE-754
 * artifacts (0.5915 × 100 = 59.150000000000006, (59.15).toFixed(1) = "59.1")
 * must be impossible on this path. Numeric legacy inputs (catalog percent
 * numbers) go through the explicit `compactWinRateFromPercent` path only.
 *
 * This is a PRODUCTION module: dev/ modules are stubbed out of release
 * builds, so nothing here may live under dev/.
 */

const FRACTION_PATTERN = /^\d+(\.\d+)?$/;

/**
 * Convert a 0–1 fraction STRING to a percentage STRING by shifting the decimal
 * point right two places on the digits themselves — never floating-point
 * multiplication. Trailing fractional zeros are preserved (source precision);
 * leading integer zeros are stripped.
 *
 *   "0.563213" → "56.3213"   "0.5" → "50"   "0.5000" → "50.00"
 *   "1" → "100"              "0"   → "0"
 *
 * Throws on any non-`\d+(\.\d+)?` input so malformed data never renders.
 */
export function decimalShiftPercent(fraction: string): string {
  if (typeof fraction !== "string" || !FRACTION_PATTERN.test(fraction)) {
    throw new Error(`decimalShiftPercent: malformed fraction "${fraction}"`);
  }
  const [intPart, fracPart = ""] = fraction.split(".");
  const digits = intPart + fracPart;
  const pointPos = intPart.length + 2; // ×100 shifts the point right by 2
  let out: string;
  if (pointPos >= digits.length) {
    out = digits + "0".repeat(pointPos - digits.length);
  } else {
    out = `${digits.slice(0, pointPos)}.${digits.slice(pointPos)}`;
  }
  // Strip leading integer zeros but keep at least one digit; leave the
  // fractional part (and its trailing zeros) untouched.
  return out.replace(/^0+(?=\d)/, "");
}

/** Increment a non-negative integer string by one digit carry ("99" → "100"). */
function incrementIntegerString(value: string): string {
  const digits = value.split("");
  for (let index = digits.length - 1; index >= 0; index -= 1) {
    if (digits[index] !== "9") {
      digits[index] = String(Number(digits[index]) + 1);
      return digits.join("");
    }
    digits[index] = "0";
  }
  return `1${digits.join("")}`;
}

function percentExceedsHundred(percent: string): boolean {
  const [rawInt, fracPart = ""] = percent.split(".");
  const intPart = rawInt.replace(/^0+(?=\d)/, "");
  if (intPart.length > 3) return true;
  if (intPart.length === 3) {
    if (intPart !== "100") return true;
    return /[1-9]/.test(fracPart);
  }
  return false;
}

/**
 * Round a percent STRING to exactly one decimal digit, half-up, on digit
 * comparison with a string carry: "59.15" → "59.2", "59.9999" → "60.0",
 * "99.95" → "100.0", "50" → "50.0". Throws on malformed input.
 */
export function roundPercentOneDecimalHalfUp(percent: string): string {
  if (typeof percent !== "string" || !FRACTION_PATTERN.test(percent)) {
    throw new Error(`roundPercentOneDecimalHalfUp: malformed percent "${percent}"`);
  }
  const [rawInt, fracPart = ""] = percent.split(".");
  let intPart = rawInt.replace(/^0+(?=\d)/, "");
  let firstDecimal = fracPart.charAt(0) || "0";
  // Half-up: the digit right after the kept decimal place decides.
  const roundsUp = (fracPart.charCodeAt(1) || 0) >= 53; /* "5" */
  if (roundsUp) {
    if (firstDecimal === "9") {
      firstDecimal = "0";
      intPart = incrementIntegerString(intPart);
    } else {
      firstDecimal = String(Number(firstDecimal) + 1);
    }
  }
  return `${intPart}.${firstDecimal}`;
}

/**
 * ARAMGG fraction string → compact chip percentage: "0.5915" → "59.2%".
 * Returns null (renders nothing) for malformed, negative-signed, or above-1
 * input — a bad scrape value must never crash the overlay or invent a number.
 * The caller keeps the raw fraction for diagnostics; this formats only.
 */
export function compactWinRateFromFraction(fraction: string): string | null {
  if (typeof fraction !== "string" || !FRACTION_PATTERN.test(fraction)) {
    return null;
  }
  const percent = decimalShiftPercent(fraction);
  if (percentExceedsHundred(percent)) return null;
  return `${roundPercentOneDecimalHalfUp(percent)}%`;
}

/**
 * Explicit path for legacy PERCENT-space inputs (catalog `win_rate` numbers
 * like 61.5667, or already-shifted percent strings like "59.15"): "61.6%".
 * Numbers are stringified once and rounded with the same digit mechanics;
 * out-of-range or malformed input returns null.
 */
export function compactWinRateFromPercent(
  value: number | string | null | undefined,
): string | null {
  let percent: string;
  if (typeof value === "number") {
    if (!Number.isFinite(value) || value < 0 || value > 100) return null;
    percent = String(value);
  } else if (typeof value === "string") {
    percent = value;
  } else {
    return null;
  }
  if (!FRACTION_PATTERN.test(percent) || percentExceedsHundred(percent)) {
    return null;
  }
  return `${roundPercentOneDecimalHalfUp(percent)}%`;
}

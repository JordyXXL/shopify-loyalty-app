/* global BigInt */
/**
 * Money as decimal strings, never floats: the same helpers as Connect's own Shopify integration (Connect
 * src/platforms/shopify/common.ts "money"), so an amount is written exactly as Connect writes it. Pure, no imports.
 */
const UNITS = 10000n; // four fraction digits, as Connect's order contract takes them

/** Ten-thousandths of a decimal string or a number; undefined when it is not an amount. */
export function moneyUnits(v) {
  let s;
  if (typeof v === "number") {
    if (!Number.isFinite(v)) return undefined;
    s = v.toFixed(6);
  } else if (typeof v === "string") s = v.trim();
  else return undefined;
  const m = /^(-?)(\d{1,15})(?:\.(\d+))?$/.exec(s);
  if (!m) return undefined;
  const [, sign, whole, frac = ""] = m;
  const padded = frac.padEnd(5, "0");
  let units = BigInt(whole) * UNITS + BigInt(padded.slice(0, 4));
  if (Number(padded[4]) >= 5) units += 1n;
  return sign && units !== 0n ? -units : units;
}

/** "12.30", "12.3456", "-4.50": at least two and at most four fraction digits. */
export function unitsToMoney(u) {
  const neg = u < 0n;
  const a = neg ? -u : u;
  let frac = (a % UNITS).toString().padStart(4, "0");
  while (frac.length > 2 && frac.endsWith("0")) frac = frac.slice(0, -1);
  return `${neg ? "-" : ""}${a / UNITS}.${frac}`;
}

/** A decimal string for Connect, or undefined when the value is not an amount. */
export const money = (v) => {
  const u = moneyUnits(v);
  return u === undefined ? undefined : unitsToMoney(u);
};
export const sumMoney = (values) => unitsToMoney(values.reduce((n, v) => n + (moneyUnits(v) ?? 0n), 0n));
export const subMoney = (a, b) => unitsToMoney((moneyUnits(a) ?? 0n) - (moneyUnits(b) ?? 0n));
/** a, held between low and high */
export const clampMoney = (a, low, high) => {
  const x = moneyUnits(a) ?? 0n;
  const lo = moneyUnits(low) ?? 0n;
  const hi = moneyUnits(high) ?? 0n;
  return unitsToMoney(x < lo ? lo : x > hi ? hi : x);
};

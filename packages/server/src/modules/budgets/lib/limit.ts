/**
 * Budget-limit arithmetic — PURE, so the float edge cases are unit-testable without a database.
 */

/** The scale of `budgets.limit_usd` (`numeric(12,4)`). */
const LIMIT_SCALE = 4;

/**
 * Can this value be stored at the column's scale without being rounded?
 *
 * Not a bare `Number.isInteger(value * 1e4)`: most decimal fractions are inexact as binary doubles,
 * so `0.07 * 1e4` is `700.0000000000001` and that check would reject a 7-cent limit the column
 * stores perfectly. `toPrecision(15)` discards the noise below the 15th significant digit —
 * comfortably inside a double's ~15–17 digits of real precision — leaving the decimal expansion the
 * caller actually typed. The same trick guards the rate-card comparison in `modules/catalog`.
 */
export function hasStorableScale(value: number): boolean {
  const scaled = Number((value * 10 ** LIMIT_SCALE).toPrecision(15));
  return Number.isInteger(scaled);
}

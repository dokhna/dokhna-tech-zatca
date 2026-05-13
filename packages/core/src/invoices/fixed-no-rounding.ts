/**
 * `toFixedNoRounding` — replicates rwiqha-backend's prototype
 * extension on `Number`.
 *
 * The legacy helper attached this method to `Number.prototype` to
 * produce ZATCA-spec amount strings: truncate (do not round) to the
 * requested number of decimal places, then right-pad zeros so the
 * fractional part always has exactly that width.
 *
 * Examples:
 *
 *   toFixedNoRounding(20, 2)        => "20.00"
 *   toFixedNoRounding(20.5, 2)      => "20.50"
 *   toFixedNoRounding(3.149, 2)     => "3.14"   // no rounding
 *   toFixedNoRounding(-3.149, 2)    => "-3.14"
 *   toFixedNoRounding(0, 2)         => "0.00"
 *
 * The function is a plain export so we don't pollute the global
 * `Number.prototype` — the legacy approach was hostile to bundlers
 * and to libraries that don't want monkey-patches.
 *
 * Behaviour is byte-identical to the rwiqha original; the regex is
 * lifted as-is so the same edge cases (negative-numbers, integers,
 * already-truncated values) reproduce.
 */

/**
 * Truncates `value` to `n` fractional digits and right-pads with
 * zeros so the result always has exactly `n` decimals.
 */
export function toFixedNoRounding(value: number, n: number): string {
  const regex = new RegExp(`^-?\\d+(?:\\.\\d{0,${n}})?`, "g");
  const matches = value.toString().match(regex);
  if (matches !== null && matches.length > 0) {
    const a = matches[0];
    if (a === undefined) return "0.00";
    const dot = a.indexOf(".");
    if (dot === -1) {
      return `${a}.${"0".repeat(n)}`;
    }
    const b = n - (a.length - dot) + 1;
    return b > 0 ? a + "0".repeat(b) : a;
  }
  return "0.00";
}

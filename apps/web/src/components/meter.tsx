/**
 * The odometer. A counter's number set in mechanical digit housings rather
 * than as text.
 *
 * The number is not decoration: it is assigned once, gap-free, in
 * (block, tx_index, msg_index) order, and it can never change or be
 * reassigned. #0 is XDUALS and will be for as long as Bitcoin is. Setting it
 * as a measurement rather than a label is the honest presentation, and it is
 * how the reference explorer does it.
 */

interface Props {
  value: number;
  /** Digit height in px; width follows at 0.78em, as in the explorer. */
  size?: number;
  /** Pad to a fixed width so a column of numbers lines up. */
  pad?: number;
  className?: string;
}

export function Meter({ value, size = 13, pad = 0, className = "" }: Props) {
  const digits = String(Math.max(0, Math.trunc(value))).padStart(pad, "0").split("");

  return (
    <span className={`meter ${className}`} aria-label={`Counter number ${value}`}>
      <span className="sr-only">{value}</span>
      {digits.map((digit, i) => (
        <span
          key={i}
          aria-hidden
          className="d"
          style={{ fontSize: size, width: "1.05em", height: "1.5em" }}
        >
          {digit}
        </span>
      ))}
    </span>
  );
}

/** A separator-joined pair of meters, for `block · position` style readouts. */
export function MeterPair({ left, right, size = 13 }: { left: number; right: number; size?: number }) {
  return (
    <span className="meter">
      <Meter value={left} size={size} />
      <span className="sep" style={{ fontSize: size }}>
        /
      </span>
      <Meter value={right} size={size} />
    </span>
  );
}

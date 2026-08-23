/**
 * The seven session states.
 *
 * The reference palette is achromatic — `--destructive` is its only chromatic token — so
 * these separate on fill, border style and weight rather than colour, with red reserved for
 * the two states that actually need a human. See globals.css and docs/design-reference.md.
 */
const LABEL: Record<string, string> = {
  connected: "connected",
  connecting: "connecting",
  need_scan: "scan QR",
  need_passkey: "passkey",
  disconnected: "disconnected",
  logged_out: "logged out",
  expired: "expired",
};

export function StatusBadge({ status }: { status: string }) {
  return <span className={`status status-${status}`}>{LABEL[status] ?? status}</span>;
}

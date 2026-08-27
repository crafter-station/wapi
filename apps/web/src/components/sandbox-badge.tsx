/**
 * Marks a session as fake, wherever one is shown.
 *
 * Not decoration. Someone who has just sent a test message and seen it "delivered" needs to know
 * instantly whether anything left the building — the same reasoning that made both engines assert
 * their own precondition, applied to the person rather than the process. A sandbox and a real
 * number looking identical in a list is a trap, and the sandbox is designed to sit *alongside*
 * someone's real session.
 *
 * Deliberately not a warning colour: a sandbox session is working correctly, not degraded.
 */
export function SandboxBadge({ className = "" }: { className?: string }) {
  return (
    <span
      title="Fake number on a fake WhatsApp. Nothing sent here reaches anyone."
      className={
        "inline-flex shrink-0 items-center rounded-full border border-[var(--border)] " +
        "bg-[var(--muted)] px-2 py-0.5 text-[0.7rem] font-[520] uppercase tracking-[0.06em] " +
        "text-[var(--muted-foreground)] " +
        className
      }
    >
      sandbox
    </span>
  );
}

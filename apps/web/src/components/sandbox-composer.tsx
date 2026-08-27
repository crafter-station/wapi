"use client";

import { useRef } from "react";
import { sandboxInboundAction } from "@/lib/actions";

/**
 * Write a message *as one of the fake contacts*.
 *
 * Deliberately not a "send a message" box. The dashboard already has the API for sending, and a
 * composer that sent outbound would just be a worse version of it. What has no other affordance
 * anywhere is inbound — making a message arrive — and that is the one that fires the webhook a
 * developer is actually trying to debug.
 *
 * A client component only so the field can clear itself after submitting; the work is a server
 * action either way.
 */
export function SandboxComposer({
  id,
  contacts,
}: {
  id: number;
  contacts: { jid: string; label: string }[];
}) {
  const formRef = useRef<HTMLFormElement>(null);

  return (
    <form
      ref={formRef}
      action={async (formData: FormData) => {
        await sandboxInboundAction(formData);
        formRef.current?.reset();
      }}
      className="flex flex-wrap items-center gap-2 border-t border-[var(--border)] p-3"
    >
      <input type="hidden" name="id" value={id} />
      <select
        name="from"
        className="rounded-[var(--radius)] border border-[var(--border)] bg-[var(--background)] px-2.5 py-2 text-[0.8rem]"
        aria-label="Sender"
      >
        {contacts.map((c) => (
          <option key={c.jid} value={c.jid}>
            {c.label}
          </option>
        ))}
      </select>
      <input
        name="text"
        required
        maxLength={4096}
        placeholder="Write as this contact…"
        aria-label="Message"
        className="min-w-[160px] flex-1 rounded-[var(--radius)] border border-[var(--border)] bg-[var(--background)] px-3 py-2 text-[0.875rem]"
      />
      <button className="btn btn-primary">Receive</button>
    </form>
  );
}

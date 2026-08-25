"use client";

import { useActionState, useState } from "react";
import { updateSettingsAction, type SettingsState } from "@/lib/actions";

type Session = {
  id: number;
  webhookUrl: string | null;
  webhookEnabled: boolean;
  webhookHmac: boolean;
  webhookEvents: string[];
  proxyUrl: string | null;
  accountProtection: boolean;
  logMessages: boolean;
  readIncomingMessages: boolean;
  autoRejectCalls: boolean;
  alwaysOnline: boolean;
  ignoreGroups: boolean;
  ignoreChannels: boolean;
  ignoreBroadcasts: boolean;
};

const Check = ({
  name,
  label,
  hint,
  defaultChecked,
}: {
  name: string;
  label: string;
  hint?: string;
  defaultChecked: boolean;
}) => (
  <label className="flex cursor-pointer items-start gap-3 py-2">
    <input
      type="checkbox"
      name={name}
      defaultChecked={defaultChecked}
      className="mt-1 size-4 shrink-0 accent-[var(--foreground)]"
    />
    <span className="min-w-0">
      <span className="block text-[0.9rem] font-[520]">{label}</span>
      {hint ? (
        <span className="block text-[0.8rem] leading-[1.6] text-[var(--muted-foreground)]">
          {hint}
        </span>
      ) : null}
    </span>
  </label>
);

const Field = ({ label, children }: { label: string; children: React.ReactNode }) => (
  <label className="block">
    <span className="block text-[0.9rem] font-[520]">{label}</span>
    {children}
  </label>
);

const input =
  "code mt-1.5 w-full rounded-[var(--radius)] border border-[var(--input)] bg-transparent px-3 py-2 text-[0.9rem] outline-none focus:border-[var(--ring)]";

/**
 * Session settings.
 *
 * Everything here was previously reachable only by curl against `PUT /api/whatsapp-sessions`,
 * which is an odd thing to require in a product that has a dashboard — and it is a prerequisite
 * for the webhook features, since you cannot inspect deliveries you cannot configure.
 *
 * Validation is repeated on the server (`updateSettingsAction`); the checks here exist to give
 * a faster answer, never to be the only answer.
 */
export function SettingsForm({ session, events }: { session: Session; events: readonly string[] }) {
  const [state, action, pending] = useActionState<SettingsState, FormData>(
    updateSettingsAction,
    null,
  );
  const [selected, setSelected] = useState<string[]>(session.webhookEvents ?? []);

  return (
    <form action={action} className="mt-8 max-w-[720px] space-y-10">
      <input type="hidden" name="id" value={session.id} />

      <section>
        <p className="kicker">Webhooks</p>
        <div className="mt-4 space-y-4">
          <Field label="Delivery URL">
            <input
              className={input}
              name="webhook_url"
              type="url"
              placeholder="https://your.app/api/wapi/webhook"
              defaultValue={session.webhookUrl ?? ""}
            />
          </Field>
          <Check
            name="webhook_enabled"
            label="Deliver events"
            hint="Off keeps the URL saved but sends nothing."
            defaultChecked={session.webhookEnabled}
          />
          <Check
            name="webhook_hmac"
            label="Sign with HMAC-SHA256"
            hint="Recommended. Off reproduces the original's scheme, which sends the shared secret itself in the X-Webhook-Signature header."
            defaultChecked={session.webhookHmac}
          />

          <div>
            <p className="text-[0.9rem] font-[520]">Events</p>
            {/*
              Their semantic, surfaced rather than left to be discovered: an empty selection
              means everything. Reading a page with no boxes ticked as "no events" is the
              opposite of what it does.
            */}
            <p className="mt-1 text-[0.8rem] leading-[1.6] text-[var(--muted-foreground)]">
              {selected.length === 0
                ? "Nothing selected — every event will be delivered."
                : `${selected.length} of ${events.length} selected.`}
            </p>
            <div className="mt-3 grid gap-x-6 sm:grid-cols-2">
              {events.map((e) => (
                <label key={e} className="flex cursor-pointer items-center gap-2.5 py-1">
                  <input
                    type="checkbox"
                    name="webhook_events"
                    value={e}
                    defaultChecked={selected.includes(e)}
                    onChange={(ev) =>
                      setSelected((prev) =>
                        ev.target.checked ? [...prev, e] : prev.filter((x) => x !== e),
                      )
                    }
                    className="size-4 shrink-0 accent-[var(--foreground)]"
                  />
                  <span className="code truncate text-[0.8rem]">{e}</span>
                </label>
              ))}
            </div>
          </div>
        </div>
      </section>

      <section>
        <p className="kicker">Behaviour</p>
        <div className="mt-3">
          <Check
            name="account_protection"
            label="Account protection"
            hint="Paces sends to one every five seconds. It reduces risk to the number; it does not remove it."
            defaultChecked={session.accountProtection}
          />
          <Check
            name="log_messages"
            label="Log messages"
            hint="Stores sent messages so they appear in the message log."
            defaultChecked={session.logMessages}
          />
          <Check
            name="read_incoming_messages"
            label="Mark incoming as read"
            hint="Sends read receipts automatically. Visible to the sender."
            defaultChecked={session.readIncomingMessages}
          />
          <Check
            name="auto_reject_calls"
            label="Auto-reject calls"
            defaultChecked={session.autoRejectCalls}
          />
          <Check
            name="always_online"
            label="Always online"
            hint="Keeps presence set to available. Visible to your contacts."
            defaultChecked={session.alwaysOnline}
          />
        </div>
      </section>

      <section>
        <p className="kicker">Event filters</p>
        <p className="mt-2 text-[0.8rem] leading-[1.6] text-[var(--muted-foreground)]">
          Filtered events are dropped before delivery — they will not appear in webhooks or the
          inspector.
        </p>
        <div className="mt-3">
          <Check name="ignore_groups" label="Ignore groups" defaultChecked={session.ignoreGroups} />
          <Check
            name="ignore_channels"
            label="Ignore channels"
            defaultChecked={session.ignoreChannels}
          />
          <Check
            name="ignore_broadcasts"
            label="Ignore broadcasts"
            defaultChecked={session.ignoreBroadcasts}
          />
        </div>
      </section>

      <section>
        <p className="kicker">Proxy</p>
        <div className="mt-4">
          <Field label="Proxy URL">
            <input
              className={input}
              name="proxy_url"
              placeholder="socks5://user:pass@proxy.example.com:1080"
              defaultValue={session.proxyUrl ?? ""}
            />
          </Field>
          <p className="mt-2 text-[0.8rem] leading-[1.6] text-[var(--muted-foreground)]">
            http, https or socks5, on a public hostname. IP addresses and private ranges are
            rejected — this becomes an outbound proxy for our egress.
          </p>
        </div>
      </section>

      <div className="flex items-center gap-4 border-t border-[var(--border)] pt-6">
        <button className="btn btn-primary" disabled={pending}>
          {pending ? "Saving…" : "Save settings"}
        </button>
        {state?.error ? (
          <span className="text-[0.85rem] text-[var(--destructive)]">{state.error}</span>
        ) : null}
        {state?.ok ? (
          <span className="text-[0.85rem] text-[var(--muted-foreground)]">Saved.</span>
        ) : null}
      </div>
    </form>
  );
}

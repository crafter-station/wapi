"use server";

import { revalidatePath } from "next/cache";
import { redirect } from "next/navigation";
import { runDoctor, type DoctorResult } from "./doctor";
import {
  createSandboxSession,
  createSession,
  currentAccountId,
  createToken,
  deleteSession,
  getSession,
  regenerateSessionKey,
  revokeToken,
  updateSessionSettings,
  WEBHOOK_EVENTS,
} from "./data";
import { validateProxy } from "@wapi/core";

/**
 * Server actions.
 *
 * Every one re-resolves the account from Clerk inside `data.ts`; none trusts an id from the
 * client. Actions bound directly to a `<form action>` return void — anything that needs to
 * surface a value back to the page goes through `useActionState` instead.
 */

export async function createSessionAction(formData: FormData): Promise<void> {
  const name = String(formData.get("name") ?? "").trim();
  const phoneNumber = String(formData.get("phone_number") ?? "").trim();
  if (!name || !phoneNumber) return;
  const session = await createSession({
    name,
    phoneNumber,
    accountProtection: formData.get("account_protection") === "on",
  });
  revalidatePath("/sessions");
  redirect(`/sessions/${session.id}`);
}

/**
 * Create a sandbox session.
 *
 * Separate action from `createSessionAction` rather than a checkbox on it, mirroring the API: a
 * sandbox session takes no phone number, because one is derived. A shared form would have to
 * disable half its own fields.
 */
export async function createSandboxAction(formData: FormData): Promise<void> {
  const name = String(formData.get("name") ?? "").trim() || "Sandbox";
  const session = await createSandboxSession(name);
  revalidatePath("/sessions");
  redirect(`/sessions/${session.id}`);
}

export async function deleteSessionAction(formData: FormData): Promise<void> {
  await deleteSession(Number(formData.get("id")));
  revalidatePath("/sessions");
  redirect("/sessions");
}

export async function revokeTokenAction(formData: FormData): Promise<void> {
  await revokeToken(Number(formData.get("id")));
  revalidatePath("/tokens");
}

/**
 * Ask the gateway to connect.
 *
 * The dashboard calls the gateway directly rather than going through the public API — it is
 * the same application, and routing through HTTP would mean minting a credential for
 * ourselves. A hard deadline is mandatory here: the failure mode of a remote WhatsApp call is
 * silence, not an error.
 */
export async function connectAction(formData: FormData): Promise<void> {
  const id = Number(formData.get("id"));
  const session = await getSession(id);
  if (!session) return;

  const base = process.env["GATEWAY_URL"] ?? "http://gateway:3002";
  await fetch(`${base}/rpc/connect`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "X-Gateway-Token": process.env["GATEWAY_TOKEN"] ?? "",
    },
    body: JSON.stringify({ sessionId: id, accountProtection: session.accountProtection }),
    signal: AbortSignal.timeout(20_000),
  }).catch(() => null);

  revalidatePath(`/sessions/${id}`);
}

export type TokenState = { token?: string; error?: string } | null;

/** Returns the plaintext once. Only the hash is stored, so there is no second chance. */
export async function createTokenAction(_prev: TokenState, formData: FormData): Promise<TokenState> {
  const name = String(formData.get("name") ?? "").trim() || "untitled";
  try {
    const token = await createToken(name);
    revalidatePath("/tokens");
    return { token };
  } catch {
    return { error: "Could not create the token." };
  }
}


/**
 * One helper for the three lifecycle verbs, which differ only in the RPC path.
 *
 * Like `connectAction`, these talk to the gateway directly rather than through the public API:
 * it is the same application, and routing through HTTP would mean minting a credential for
 * ourselves. The deadline is not optional — the failure mode of a remote WhatsApp call is
 * silence, not an error.
 */
async function gatewayRpc(path: string, body: unknown): Promise<void> {
  const base = process.env["GATEWAY_URL"] ?? "http://gateway:3002";
  await fetch(`${base}${path}`, {
    body: JSON.stringify(body),
    headers: {
      "Content-Type": "application/json",
      "X-Gateway-Token": process.env["GATEWAY_TOKEN"] ?? "",
    },
    method: "POST",
    signal: AbortSignal.timeout(20_000),
  }).catch(() => null);
}

export async function disconnectAction(formData: FormData): Promise<void> {
  const id = Number(formData.get("id"));
  if (!(await getSession(id))) return;
  await gatewayRpc("/rpc/disconnect", { sessionId: id });
  revalidatePath(`/sessions/${id}`);
}

export async function restartAction(formData: FormData): Promise<void> {
  const id = Number(formData.get("id"));
  const session = await getSession(id);
  if (!session) return;
  await gatewayRpc("/rpc/restart", {
    accountProtection: session.accountProtection,
    sessionId: id,
  });
  revalidatePath(`/sessions/${id}`);
}

export type SettingsState = { error?: string; ok?: true } | null;

/**
 * Save session settings.
 *
 * Two things are validated rather than trusted. `proxy_url` goes through the same SSRF guard
 * the public API applies — it becomes an outbound proxy for our egress, so a private address
 * here would turn the dashboard into a request forwarder into our own network. And the event
 * list is intersected with what the worker actually emits, so a hand-crafted form post cannot
 * store subscriptions to events that will never fire.
 */
export async function updateSettingsAction(
  _prev: SettingsState,
  formData: FormData,
): Promise<SettingsState> {
  const id = Number(formData.get("id"));
  if (!(await getSession(id))) return { error: "Session not found." };

  const on = (k: string) => formData.get(k) === "on";
  const text = (k: string) => {
    const v = String(formData.get(k) ?? "").trim();
    return v === "" ? null : v;
  };

  const proxyUrl = text("proxy_url");
  if (proxyUrl) {
    const problem = validateProxy(proxyUrl);
    if (problem) return { error: problem };
  }

  const webhookUrl = text("webhook_url");
  if (webhookUrl) {
    try {
      const u = new URL(webhookUrl);
      if (u.protocol !== "https:" && u.protocol !== "http:") {
        return { error: "The webhook URL must be http or https." };
      }
    } catch {
      return { error: "The webhook URL must be a valid URL." };
    }
  }
  if (on("webhook_enabled") && !webhookUrl) {
    return { error: "Enable webhooks only with a URL to deliver to." };
  }

  const allowed = new Set<string>(WEBHOOK_EVENTS);
  const webhookEvents = formData
    .getAll("webhook_events")
    .map(String)
    .filter((e) => allowed.has(e));

  await updateSessionSettings(id, {
    accountProtection: on("account_protection"),
    alwaysOnline: on("always_online"),
    autoRejectCalls: on("auto_reject_calls"),
    ignoreBroadcasts: on("ignore_broadcasts"),
    ignoreChannels: on("ignore_channels"),
    ignoreGroups: on("ignore_groups"),
    logMessages: on("log_messages"),
    proxyUrl,
    readIncomingMessages: on("read_incoming_messages"),
    webhookEnabled: on("webhook_enabled"),
    webhookEvents,
    webhookHmac: on("webhook_hmac"),
    webhookUrl,
  });
  revalidatePath(`/sessions/${id}`);
  return { ok: true };
}

export type RegenerateState = { error?: string; key?: string } | null;

/** Returns the new key once so the page can show it; the old one is already dead. */
export async function regenerateKeyAction(
  _prev: RegenerateState,
  formData: FormData,
): Promise<RegenerateState> {
  const id = Number(formData.get("id"));
  const key = await regenerateSessionKey(id);
  if (!key) return { error: "Session not found." };
  revalidatePath(`/sessions/${id}`);
  return { key };
}

export type DoctorState = { error?: string; result?: DoctorResult } | null;

/**
 * Run the connection doctor.
 *
 * The only write it performs is a message to the session's own number — never a group, never a
 * third party. A health check has to be safe to press repeatedly by anyone who can see it.
 *
 * Not exposed on a schedule: an unattended process sending WhatsApp messages on a timer, from a
 * number that can be banned, for a signal nobody is watching, is the least deliberate version
 * of the thing we said should be deliberate.
 */
export async function runDoctorAction(
  _prev: DoctorState,
  formData: FormData,
): Promise<DoctorState> {
  const id = Number(formData.get("id"));
  const accountId = await currentAccountId();
  try {
    const result = await runDoctor(id, accountId);
    if (!result) return { error: "Session not found, or it has no API key yet." };
    revalidatePath(`/sessions/${id}/doctor`);
    revalidatePath("/sessions");
    return { result };
  } catch (err) {
    return { error: err instanceof Error ? err.message : "The check could not be completed." };
  }
}

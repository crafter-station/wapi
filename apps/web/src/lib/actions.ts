"use server";

import { revalidatePath } from "next/cache";
import { redirect } from "next/navigation";
import { createSession, deleteSession, createToken, revokeToken, getSession } from "./data";

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

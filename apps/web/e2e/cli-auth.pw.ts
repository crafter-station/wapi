import { expect, test } from "@playwright/test";

/**
 * The CLI device flow, end to end.
 *
 * This is the one exchange that spans both halves of the product — a terminal with no browser
 * session, and a browser that has one — so testing either half alone proves very little. Here the
 * whole thing runs: start a request over HTTP the way the CLI does, approve it in a real signed-in
 * browser the way a person does, then collect the token over HTTP and *use it against the API*.
 *
 * That last step matters most. A flow that mints a credential nobody checks is a flow that can
 * hand out a broken one.
 */

const API = process.env["WAPI_API_URL"] ?? "http://127.0.0.1:3101";

test.describe.configure({ mode: "serial" });

test("a terminal can be authorised from the browser, and the token works", async ({
  page,
  request,
}) => {
  // 1. The terminal asks. No credential involved — this is the point of the exchange.
  const started = await request.post("/api/cli/start", { data: { hostname: "playwright" } });
  expect(started.status()).toBe(200);
  const { poll_token, user_code, verification_url } = (await started.json()) as {
    poll_token: string;
    user_code: string;
    verification_url: string;
  };
  expect(user_code).toHaveLength(8);
  // Unambiguous alphabet: a human transcribes this by eye.
  expect(user_code).toMatch(/^[ABCDEFGHJKLMNPQRSTUVWXYZ23456789]+$/);

  // 2. Nothing is available before approval, and "pending" is distinguishable from "expired" —
  //    a CLI that cannot tell them apart either gives up early or waits forever.
  const early = await request.post("/api/cli/poll", { data: { poll_token } });
  expect((await early.json())["status"]).toBe("pending");

  // 3. A person approves it in a browser that is already signed in.
  await page.goto(verification_url);
  await expect(page.getByText(user_code)).toBeVisible();
  // The machine name is shown so somebody can tell their own terminal from a stranger's.
  await expect(page.getByText("playwright").first()).toBeVisible();
  await page.getByRole("button", { name: /authorise/i }).click();
  await expect(page.getByText(/approved/i).first()).toBeVisible();

  // 4. The terminal collects.
  const collected = await request.post("/api/cli/poll", { data: { poll_token } });
  const body = (await collected.json()) as { status: string; token?: string };
  expect(body.status).toBe("approved");
  expect(body.token).toMatch(/^wapi_pat_/);

  // 5. The token is real: it authenticates against the API, as a PAT.
  const sessions = await request.get(`${API}/api/whatsapp-sessions`, {
    headers: { Authorization: `Bearer ${body.token}` },
  });
  expect(sessions.status()).toBe(200);

  // 6. Single use. The row is deleted on collection, so a replayed poll token is spent, not a
  //    second copy of the credential.
  const replay = await request.post("/api/cli/poll", { data: { poll_token } });
  expect((await replay.json())["status"]).toBe("expired");
});

test("an unknown poll token is indistinguishable from a spent one", async ({ request }) => {
  // Both answer `expired`, deliberately: neither should tell a guesser they are close.
  const res = await request.post("/api/cli/poll", { data: { poll_token: "0".repeat(64) } });
  expect((await res.json())["status"]).toBe("expired");
});

test("the approval page refuses a code that does not exist", async ({ page }) => {
  await page.goto("/cli?code=ZZZZZZZZ");
  await expect(page.getByText(/no such code/i)).toBeVisible();
  // No button to press is the point — an approval that would fail should not be offered.
  await expect(page.getByRole("button", { name: /authorise/i })).toHaveCount(0);
});

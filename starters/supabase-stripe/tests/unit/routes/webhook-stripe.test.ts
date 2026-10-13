// @vitest-environment node
// The route has no DOM: running it under node keeps the test independent of jsdom.
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import Stripe from "stripe";

const { dbUpdate, dbSet, dbWhere } = vi.hoisted(() => {
  const dbWhere = vi.fn(async () => undefined);
  const dbSet = vi.fn(() => ({ where: dbWhere }));
  const dbUpdate = vi.fn(() => ({ set: dbSet }));
  return { dbUpdate, dbSet, dbWhere };
});

vi.mock("@/utils/db/db", () => ({
  db: { update: dbUpdate },
}));

import { POST } from "@/app/webhook/stripe/route";
import { usersTable } from "@/utils/db/schema";
import { eq } from "drizzle-orm";

const SECRET = "whsec_test_secret";

// Indented like Stripe's payloads: a route that re-serializes the body instead of reading it raw fails here.
const CREATED = JSON.stringify(
  {
    type: "customer.subscription.created",
    data: { object: { id: "sub_123", customer: "cus_456" } },
  },
  null,
  2,
);

function signedRequest(payload: string, secret = SECRET, timestamp?: number): Request {
  const header = Stripe.webhooks.generateTestHeaderString({ payload, secret, timestamp });
  return new Request("http://localhost/webhook/stripe", {
    method: "POST",
    headers: { "stripe-signature": header },
    body: payload,
  });
}

describe("Stripe Webhook POST", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.spyOn(console, "log").mockImplementation(() => {});
    vi.spyOn(console, "error").mockImplementation(() => {});
    process.env.STRIPE_WEBHOOK_SECRET = SECRET;
  });

  afterEach(() => {
    delete process.env.STRIPE_WEBHOOK_SECRET;
    vi.restoreAllMocks();
  });

  it("writes the subscription id on the user matched by stripe_id", async () => {
    const response = await POST(signedRequest(CREATED));

    expect(response.status).toBe(200);
    expect(dbUpdate).toHaveBeenCalledWith(usersTable);
    expect(dbSet).toHaveBeenCalledWith({ plan: "sub_123" });
    expect(dbWhere).toHaveBeenCalledWith(eq(usersTable.stripe_id, "cus_456"));
    // No fall-through into default, and the Stripe event is never logged.
    expect(console.log).not.toHaveBeenCalled();
  });

  it("acknowledges a signed unhandled event without touching the database", async () => {
    const payload = JSON.stringify({ type: "invoice.paid", data: { object: {} } });

    const response = await POST(signedRequest(payload));
    expect(response.status).toBe(200);
    expect(dbUpdate).not.toHaveBeenCalled();
  });

  it("rejects an unsigned request without touching the database", async () => {
    const req = new Request("http://localhost/webhook/stripe", { method: "POST", body: CREATED });

    const response = await POST(req);
    expect(response.status).toBe(400);
    expect(dbUpdate).not.toHaveBeenCalled();
  });

  it("rejects a subscription event signed with another secret", async () => {
    const response = await POST(signedRequest(CREATED, "whsec_attacker"));
    expect(response.status).toBe(400);
    expect(dbUpdate).not.toHaveBeenCalled();
    // The verification error stays in server logs, never in the response.
    expect(await response.text()).toBe("Webhook error");
  });

  it("rejects any event type signed with another secret", async () => {
    const payload = JSON.stringify({ type: "invoice.paid", data: { object: {} } });

    const response = await POST(signedRequest(payload, "whsec_attacker"));
    expect(response.status).toBe(400);
    expect(dbUpdate).not.toHaveBeenCalled();
  });

  it("rejects a replayed event outside the tolerance window", async () => {
    const tenMinutesAgo = Math.floor(Date.now() / 1000) - 600;

    const response = await POST(signedRequest(CREATED, SECRET, tenMinutesAgo));
    expect(response.status).toBe(400);
    expect(dbUpdate).not.toHaveBeenCalled();
  });

  it("refuses everything and logs when STRIPE_WEBHOOK_SECRET is not set", async () => {
    delete process.env.STRIPE_WEBHOOK_SECRET;

    const response = await POST(signedRequest(CREATED));
    expect(response.status).toBe(500);
    expect(dbUpdate).not.toHaveBeenCalled();
    expect(console.error).toHaveBeenCalledWith(expect.stringContaining("STRIPE_WEBHOOK_SECRET"));
  });

  it("treats an empty STRIPE_WEBHOOK_SECRET, as shipped in .env.example, as not set", async () => {
    process.env.STRIPE_WEBHOOK_SECRET = "";

    const response = await POST(signedRequest(CREATED, ""));
    expect(response.status).toBe(500);
    expect(dbUpdate).not.toHaveBeenCalled();
  });

  it("returns 400 on a malformed signed body", async () => {
    const response = await POST(signedRequest("not json"));
    expect(response.status).toBe(400);
    expect(dbUpdate).not.toHaveBeenCalled();
  });

  it("returns 500, not 400, when the database write fails", async () => {
    dbWhere.mockRejectedValueOnce(new Error("db down"));

    const response = await POST(signedRequest(CREATED));
    expect(response.status).toBe(500);
    expect(dbSet).toHaveBeenCalledWith({ plan: "sub_123" });
  });
});

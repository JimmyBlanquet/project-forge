// @vitest-environment node
// The route has no DOM: running it under node keeps the test independent of jsdom.
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import Stripe from "stripe";

const { dbUpdate, dbSet, dbWhere, dbReturning, dbTransaction, txExecute, subsList, custRetrieve, stripeState } = vi.hoisted(() => {
  const dbReturning = vi.fn(async () => [{ id: "user_1" }]);
  const dbWhere = vi.fn(() => ({ returning: dbReturning }));
  const dbSet = vi.fn(() => ({ where: dbWhere }));
  const dbUpdate = vi.fn(() => ({ set: dbSet }));
  const txExecute = vi.fn(async (_query: unknown) => undefined);
  const dbTransaction = vi.fn(async (fn: (tx: unknown) => Promise<unknown>) => fn({ execute: txExecute, update: dbUpdate }));
  const subsList = vi.fn();
  const custRetrieve = vi.fn();
  // The route must read Stripe's CURRENT state: tests set it here, independently of the event payload.
  const stripeState = { configured: true };
  return { dbUpdate, dbSet, dbWhere, dbReturning, dbTransaction, txExecute, subsList, custRetrieve, stripeState };
});

vi.mock("@/utils/db/db", () => ({
  db: { update: dbUpdate, transaction: dbTransaction },
}));

vi.mock("@/utils/stripe/api", () => ({
  get stripe() {
    return stripeState.configured ? { subscriptions: { list: subsList }, customers: { retrieve: custRetrieve } } : null;
  },
}));

const STRIPE_READ = { timeout: 5_000, maxNetworkRetries: 1 };

type Sub = { id: string; status: string; created: number };
// Like Stripe: newest first, 100 per page, and the auto-pagination helper walks every page.
function listResult(subs: Sub[]) {
  const all = [...subs].sort((a, b) => b.created - a.created);
  return Object.assign(Promise.resolve({ data: all.slice(0, 100), has_more: all.length > 100 }), {
    autoPagingToArray: async () => all,
  });
}
function stripeHas(...subs: Sub[]) {
  subsList.mockImplementation(() => listResult(subs));
}
function stripeFails(err: Error) {
  const failed = Promise.reject(err);
  failed.catch(() => {});
  subsList.mockImplementationOnce(() =>
    Object.assign(failed, { autoPagingToArray: async () => { throw err; } }),
  );
}

import { POST } from "@/app/webhook/stripe/route";
import { usersTable } from "@/utils/db/schema";
import { eq } from "drizzle-orm";
import { PgDialect } from "drizzle-orm/pg-core";
import type { SQL } from "drizzle-orm";

const SECRET = "whsec_test_secret";

// Indented like Stripe's payloads: a route that re-serializes the body instead of reading it raw fails here.
const CREATED = JSON.stringify(
  {
    type: "customer.subscription.created",
    data: { object: { id: "sub_123", customer: "cus_456", status: "active" } },
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
    stripeState.configured = true;
    stripeHas({ id: "sub_123", status: "active", created: 1 });
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

  // --- Subscription lifecycle: access follows Stripe's current state, never the event's ---

  function subEvent(type: string, status: string, id = "sub_123"): string {
    return JSON.stringify({ type, data: { object: { id, customer: "cus_456", status } } });
  }

  it("revokes access when the only subscription is deleted", async () => {
    stripeHas({ id: "sub_123", status: "canceled", created: 1 });

    const response = await POST(signedRequest(subEvent("customer.subscription.deleted", "canceled")));
    expect(response.status).toBe(200);
    expect(subsList).toHaveBeenCalledWith(expect.objectContaining({ customer: "cus_456", status: "all" }), expect.anything());
    expect(dbSet).toHaveBeenCalledWith({ plan: "none" });
    expect(dbWhere).toHaveBeenCalledWith(eq(usersTable.stripe_id, "cus_456"));
  });

  it.each(["customer.subscription.created", "customer.subscription.updated"])(
    "ignores a stale 'active' %s delivered after the cancellation",
    async (type) => {
      stripeHas({ id: "sub_123", status: "canceled", created: 1 });

      const response = await POST(signedRequest(subEvent(type, "active")));
      expect(response.status).toBe(200);
      expect(dbSet).toHaveBeenCalledWith({ plan: "none" });
    },
  );

  it("keeps a paying customer whose stale 'canceled' event arrives after a resubscription", async () => {
    stripeHas({ id: "sub_123", status: "active", created: 1 });

    await POST(signedRequest(subEvent("customer.subscription.deleted", "canceled")));
    expect(dbSet).toHaveBeenCalledWith({ plan: "sub_123" });
  });

  it("keeps access through the other subscription when the newest one is cancelled", async () => {
    stripeHas(
      { id: "sub_old", status: "active", created: 1 },
      { id: "sub_new", status: "canceled", created: 2 },
    );

    await POST(signedRequest(subEvent("customer.subscription.deleted", "canceled", "sub_new")));
    expect(dbSet).toHaveBeenCalledWith({ plan: "sub_old" });
  });

  it("grants access from the most recent subscription that grants it", async () => {
    // Ids sort the other way round from creation dates: only the creation date decides.
    stripeHas(
      { id: "sub_a", status: "active", created: 1 },
      { id: "sub_z", status: "trialing", created: 2 },
    );

    await POST(signedRequest(subEvent("customer.subscription.created", "trialing", "sub_z")));
    expect(dbSet).toHaveBeenCalledWith({ plan: "sub_z" });
  });

  it("finds a granting subscription beyond the first page of 100", async () => {
    const recentFailures = Array.from({ length: 100 }, (_, i) => ({ id: `sub_f${i}`, status: "incomplete_expired", created: 10 + i }));
    stripeHas({ id: "sub_paid", status: "active", created: 1 }, ...recentFailures);

    await POST(signedRequest(subEvent("customer.subscription.updated", "incomplete_expired", "sub_f99")));
    expect(dbSet).toHaveBeenCalledWith({ plan: "sub_paid" });
  });

  const noSuchCustomer = () =>
    new Stripe.errors.StripeInvalidRequestError({ type: "invalid_request_error", code: "resource_missing", message: "No such customer: 'cus_456'" });

  it("revokes access when the customer was deleted in Stripe", async () => {
    stripeFails(noSuchCustomer());
    custRetrieve.mockResolvedValueOnce({ id: "cus_456", object: "customer", deleted: true });

    const response = await POST(signedRequest(subEvent("customer.subscription.deleted", "canceled")));
    expect(response.status).toBe(200);
    // Explicit empty params: a lone object of option keys would otherwise be the SDK's guess.
    expect(custRetrieve).toHaveBeenCalledWith("cus_456", {}, STRIPE_READ);
    expect(dbSet).toHaveBeenCalledWith({ plan: "none" });
  });

  // Same error when the secret key belongs to another account or mode than the webhook: never cut access on it.
  it.each([
    ["unknown to this key", () => custRetrieve.mockRejectedValueOnce(noSuchCustomer())],
    ["still live", () => custRetrieve.mockResolvedValueOnce({ id: "cus_456", object: "customer" })],
  ])("returns 500 without touching the database when the customer is missing from the list but %s", async (_, setup) => {
    stripeFails(noSuchCustomer());
    setup();

    const response = await POST(signedRequest(CREATED));
    expect(response.status).toBe(500);
    expect(dbUpdate).not.toHaveBeenCalled();
  });

  it("returns 500 without touching the database on any other Stripe error", async () => {
    stripeFails(new Stripe.errors.StripeAPIError({ type: "api_error", message: "stripe down" }));

    const response = await POST(signedRequest(CREATED));
    expect(response.status).toBe(500);
    expect(dbUpdate).not.toHaveBeenCalled();
    expect(custRetrieve).not.toHaveBeenCalled();
  });

  it("bounds the Stripe read held under the lock", async () => {
    await POST(signedRequest(CREATED));

    // timeout: 0 would fall back to the SDK default (80 s); one retry keeps a transient error from denying access.
    expect(subsList.mock.calls[0][1]).toEqual(STRIPE_READ);
  });

  it("reads Stripe and writes under a per-customer lock taken first", async () => {
    await POST(signedRequest(CREATED));

    expect(dbTransaction).toHaveBeenCalledTimes(1);
    const queries = txExecute.mock.calls.map(([q]) => new PgDialect().sqlToQuery(q as unknown as SQL));
    const lockAt = queries.findIndex((q) => /pg_advisory_xact_lock\(hashtext\(\$1\)\)/.test(q.sql));
    // Exclusive lock only: the _shared variant lets two handlers in at once.
    expect(lockAt).toBeGreaterThanOrEqual(0);
    expect(queries[lockAt].params).toEqual(["cus_456"]);
    // A handler waiting behind a stuck one gives up (500, Stripe retries) instead of holding a connection forever.
    // set local, never set: a plain set would leak into the next request on the pooled connection.
    expect(queries.slice(0, lockAt).map((q) => q.sql)).toEqual([
      "set local lock_timeout = '15s'",
      "set local idle_in_transaction_session_timeout = '30s'",
    ]);
    const lock = txExecute.mock.invocationCallOrder[lockAt];
    const [read] = subsList.mock.invocationCallOrder;
    const [write] = dbUpdate.mock.invocationCallOrder;
    expect(lock).toBeLessThan(read);
    expect(read).toBeLessThan(write);
  });

  it("logs when no user row matches the Stripe customer", async () => {
    dbReturning.mockResolvedValueOnce([]);

    const response = await POST(signedRequest(CREATED));
    expect(response.status).toBe(200);
    expect(console.error).toHaveBeenCalledWith(expect.stringContaining("cus_456"));
  });

  it("keeps access while a failed payment is retried (past_due)", async () => {
    stripeHas({ id: "sub_123", status: "past_due", created: 1 });

    await POST(signedRequest(subEvent("customer.subscription.updated", "past_due")));
    expect(dbSet).toHaveBeenCalledWith({ plan: "sub_123" });
  });

  it.each(["unpaid", "canceled", "incomplete", "incomplete_expired", "paused"])(
    "revokes access when Stripe reports the subscription as %s",
    async (status) => {
      stripeHas({ id: "sub_123", status, created: 1 });

      await POST(signedRequest(subEvent("customer.subscription.updated", status)));
      expect(dbSet).toHaveBeenCalledWith({ plan: "none" });
    },
  );

  it("does not grant access on a created subscription that is not paid yet", async () => {
    stripeHas({ id: "sub_123", status: "incomplete", created: 1 });

    await POST(signedRequest(subEvent("customer.subscription.created", "incomplete")));
    expect(dbSet).toHaveBeenCalledWith({ plan: "none" });
  });

  it("returns 500 without touching the database when Stripe cannot be read", async () => {
    stripeFails(new Error("stripe down"));

    const response = await POST(signedRequest(CREATED));
    expect(response.status).toBe(500);
    expect(dbUpdate).not.toHaveBeenCalled();
  });

  it("returns 500 without touching the database when STRIPE_SECRET_KEY is not set", async () => {
    stripeState.configured = false;

    const response = await POST(signedRequest(CREATED));
    expect(response.status).toBe(500);
    expect(dbUpdate).not.toHaveBeenCalled();
  });

  it("returns 500, not 400, when the database write fails", async () => {
    dbReturning.mockRejectedValueOnce(new Error("db down"));

    const response = await POST(signedRequest(CREATED));
    expect(response.status).toBe(500);
    expect(dbSet).toHaveBeenCalledWith({ plan: "sub_123" });
  });
});

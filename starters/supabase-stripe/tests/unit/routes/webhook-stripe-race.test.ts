// @vitest-environment node
// Two webhooks for the same customer handled at the same time: the last one to read Stripe must be the last to write.
import { describe, it, expect, vi, beforeEach } from "vitest";
import Stripe from "stripe";

const h = vi.hoisted(() => {
  const world = { status: "incomplete" };
  const row = { plan: "init" };
  const holds: Array<Promise<void>> = [];

  async function write(plan: string) {
    await holds.shift();
    row.plan = plan;
    return [{ id: "user_1" }];
  }
  // Thenable and with .returning(), so the test also runs against a route that awaits the bare update.
  const update = () => ({
    set: (v: { plan: string }) => ({
      where: () => ({
        returning: () => write(v.plan),
        then: (ok: (r: unknown) => unknown, ko: (e: unknown) => unknown) => write(v.plan).then(ok, ko),
      }),
    }),
  });
  // One lock for every transaction: the stand-in for the advisory lock, enough for a single customer.
  let lock: Promise<unknown> = Promise.resolve();
  const transaction = (fn: (tx: unknown) => Promise<unknown>) => {
    const run = lock.then(() => fn({ execute: async () => undefined, update }));
    lock = run.catch(() => undefined);
    return run;
  };
  const read = () => {
    const subs = [{ id: "sub_1", status: world.status, created: 1 }];
    return Object.assign(Promise.resolve({ data: subs, has_more: false }), { autoPagingToArray: async () => subs });
  };
  return { world, row, holds, update, transaction, read };
});

vi.mock("@/utils/db/db", () => ({ db: { update: h.update, transaction: h.transaction } }));
vi.mock("@/utils/stripe/api", () => ({ stripe: { subscriptions: { list: h.read } } }));

import { POST } from "@/app/webhook/stripe/route";

const SECRET = "whsec_test_secret";

function event(type: string, status: string): Request {
  const payload = JSON.stringify({ type, data: { object: { id: "sub_1", customer: "cus_1", status } } });
  const header = Stripe.webhooks.generateTestHeaderString({ payload, secret: SECRET });
  return new Request("http://localhost/webhook/stripe", { method: "POST", headers: { "stripe-signature": header }, body: payload });
}

const tick = () => new Promise((r) => setTimeout(r, 10));

// The first handler reads Stripe, then its database write is held back; meanwhile Stripe changes and the second
// event arrives. Without a lock the second handler writes first and the held write lands last, with the old state.
async function race(first: [string, string], second: [string, string], before: string, after: string) {
  h.world.status = before;
  h.row.plan = "init";
  let release!: () => void;
  h.holds.length = 0;
  h.holds.push(new Promise<void>((r) => (release = r)), Promise.resolve());

  const a = POST(event(...first));
  await tick();
  h.world.status = after;
  const b = POST(event(...second));
  await tick();
  release();
  const [ra, rb] = await Promise.all([a, b]);
  return { a: ra.status, b: rb.status, plan: h.row.plan };
}

describe("Stripe webhook, concurrent events for one customer", () => {
  beforeEach(() => {
    process.env.STRIPE_WEBHOOK_SECRET = SECRET;
    vi.spyOn(console, "log").mockImplementation(() => {});
  });

  it("keeps a new subscriber who paid while 'created' was still being written", async () => {
    const r = await race(["customer.subscription.created", "incomplete"], ["customer.subscription.updated", "active"], "incomplete", "active");
    expect(r).toEqual({ a: 200, b: 200, plan: "sub_1" });
  });

  it("revokes a cancellation that lands while an older 'updated' is being written", async () => {
    const r = await race(["customer.subscription.updated", "active"], ["customer.subscription.deleted", "canceled"], "active", "canceled");
    expect(r).toEqual({ a: 200, b: 200, plan: "none" });
  });
});

import Stripe from 'stripe'
import { db } from '@/utils/db/db'
import { usersTable } from '@/utils/db/schema'
import { eq, sql } from "drizzle-orm";
import { stripe } from '@/utils/stripe/api'

// Statuses that grant access. past_due keeps it while Stripe retries the payment (the customer can fix their card
// from the dashboard). It ends only if the Stripe account cancels or marks the subscription unpaid once retries fail:
// with "Leave the subscription past-due", access never ends (see README, Setup Stripe).
// active does not mean paid for subscriptions billed by invoice (collection_method: send_invoice).
const ACCESS_STATUSES: ReadonlySet<Stripe.Subscription.Status> = new Set<Stripe.Subscription.Status>(["active", "trialing", "past_due"]);

// Stripe delivers events out of order and retries them: never trust the state carried by the event.
// Re-read the customer's subscriptions and grant access from the most recent one that still grants it.
// Every Stripe read runs under the customer's lock: two 5 s attempts at most, below the 15 s lock_timeout.
const STRIPE_READ: Stripe.RequestOptions = { timeout: 5_000, maxNetworkRetries: 1 }

async function currentPlan(client: Stripe, customerId: string): Promise<string> {
    let subscriptions: Stripe.Subscription[]
    try {
        subscriptions = await client.subscriptions
            .list({ customer: customerId, status: 'all', limit: 100 }, STRIPE_READ)
            .autoPagingToArray({ limit: 10000 })
    } catch (err) {
        // A deleted customer has no subscription left. The same error comes from a secret key of another account or
        // mode than the webhook's: then it must fail (500, Stripe retries), never cut access.
        if (!(err instanceof Stripe.errors.StripeError && err.code === 'resource_missing')) throw err
        const customer = await client.customers.retrieve(customerId, {}, STRIPE_READ)
        if (!customer.deleted) throw err
        return 'none'
    }
    const granting = subscriptions.filter((s) => ACCESS_STATUSES.has(s.status)).sort((a, b) => b.created - a.created)
    return granting[0]?.id ?? 'none'
}

export async function POST(req: Request) {
    const secret = process.env.STRIPE_WEBHOOK_SECRET
    if (!secret) {
        // Server misconfiguration, not a bad request: every webhook would be rejected silently otherwise.
        console.error('STRIPE_WEBHOOK_SECRET not set — rejecting all Stripe webhooks')
        return new Response('Webhook error', { status: 500 })
    }

    const signature = req.headers.get('stripe-signature')
    if (!signature) {
        return new Response('Webhook error: missing signature', { status: 400 })
    }

    let event: Stripe.Event
    try {
        // Raw body required: the signature covers the exact bytes Stripe sent.
        // Async variant: works on both the node and edge runtimes.
        event = await Stripe.webhooks.constructEventAsync(await req.text(), signature, secret)
    } catch (err) {
        // Details stay in server logs: the response body is shown in Stripe's dashboard.
        console.error('Stripe webhook signature error:', err instanceof Error ? err.message : err)
        return new Response('Webhook error', { status: 400 })
    }

    try {
        // NOTE: handle other event types as you need
        switch (event.type) {
            case 'customer.subscription.created':
            case 'customer.subscription.updated':
            case 'customer.subscription.deleted': {
                if (!stripe) throw new Error('STRIPE_SECRET_KEY not set: cannot read the subscription state')
                const subscription = event.data.object
                const customerId = typeof subscription.customer === 'string' ? subscription.customer : subscription.customer.id
                const client = stripe
                // Two events for one customer can be handled at once: the lock makes the last to read Stripe the last to write.
                const updated = await db.transaction(async (tx) => {
                    // A handler stuck behind another gives up with a 500 (Stripe retries) instead of holding a connection.
                    await tx.execute(sql`set local lock_timeout = '15s'`)
                    // A process frozen mid-transaction releases the lock instead of holding it until the connection dies.
                    await tx.execute(sql`set local idle_in_transaction_session_timeout = '30s'`)
                    await tx.execute(sql`select pg_advisory_xact_lock(hashtext(${customerId}))`)
                    const plan = await currentPlan(client, customerId)
                    return tx.update(usersTable).set({ plan }).where(eq(usersTable.stripe_id, customerId)).returning({ id: usersTable.id })
                })
                if (updated.length === 0) console.error(`Stripe webhook: no user with stripe_id ${customerId}`)
                break;
            }
            default:
                console.log(`Unhandled event type ${event.type}`);
        }

        return new Response('Success', { status: 200 })
    } catch (err) {
        // A processing failure is not a forged request: 500 keeps it apart from a bad signature in logs and monitoring.
        console.error('Stripe webhook processing error:', err instanceof Error ? err.message : err)
        return new Response('Webhook error', { status: 500 })
    }
}

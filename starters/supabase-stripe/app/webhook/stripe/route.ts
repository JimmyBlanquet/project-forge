import Stripe from 'stripe'
import { db } from '@/utils/db/db'
import { usersTable } from '@/utils/db/schema'
import { eq } from "drizzle-orm";

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
            case 'customer.subscription.created': {
                const subscription = event.data.object
                const customerId = typeof subscription.customer === 'string' ? subscription.customer : subscription.customer.id
                await db.update(usersTable).set({ plan: subscription.id }).where(eq(usersTable.stripe_id, customerId));
                break;
            }
            case 'customer.subscription.updated':
            case 'customer.subscription.deleted':
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

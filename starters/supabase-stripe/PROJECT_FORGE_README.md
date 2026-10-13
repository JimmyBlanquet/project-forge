# Supabase + Stripe Starter (Project-Forge)

**Source:** [dzlau/stripe-supabase-saas-template](https://github.com/dzlau/stripe-supabase-saas-template)
**Commit:** 7efcba2
**Ajouté à Project-Forge:** 2026-02-07

---

## Pourquoi ce Starter ?

Starter léger orienté **Supabase-first** avec Stripe intégré. Idéal pour les projets qui utilisent l'écosystème Supabase (Auth, PostgreSQL, RLS) plutôt que Auth.js + Prisma.

## Stack Technique

| Layer | Technology | Version |
|-------|-----------|---------|
| **Framework** | Next.js | 14.2.x (App Router) |
| **Language** | TypeScript | 5.x (strict) |
| **UI** | shadcn/ui + Radix | Latest |
| **Styling** | Tailwind CSS | 3.4.x |
| **Auth** | Supabase Auth | SSR (@supabase/ssr) |
| **Database** | Supabase PostgreSQL | Via postgres.js |
| **ORM** | Drizzle ORM | 0.33.x |
| **Payments** | Stripe | 16.x (Pricing Table) |
| **Icons** | Lucide React + React Icons | Latest |

## Features incluses

- Supabase Auth (email/password + OAuth Google/GitHub)
- Forgot/reset password flow
- Dashboard protégé avec middleware
- Stripe Pricing Table + webhooks
- Drizzle ORM avec migrations
- Script de setup Stripe (`stripe:setup`)
- UI shadcn/ui de base

## Structure

```
app/
├── auth/           # Callbacks et actions auth
├── dashboard/      # Zone protégée
├── login/          # Page login
├── signup/         # Page signup
├── forgot-password/# Reset password
├── subscribe/      # Stripe pricing table
└── webhook/        # Stripe webhooks
components/
├── ui/             # shadcn/ui base components
├── LoginForm.tsx   # Auth forms
└── DashboardHeader.tsx
utils/
├── db/             # Drizzle config et schema
├── stripe/         # Stripe helpers
└── supabase/       # Client/server Supabase
lib/
└── utils.ts        # Utility functions (cn, etc.)
```

## Comparaison avec saas-base

| | **saas-base** | **supabase-stripe** |
|---|---|---|
| Auth | Auth.js v5 (NextAuth) | Supabase Auth (SSR) |
| Database | Neon + Prisma | Supabase PostgreSQL + Drizzle |
| Payments | Stripe (custom) | Stripe (Pricing Table) |
| Email | Resend + React Email | Non inclus |
| Blog | Contentlayer (MDX) | Non inclus |
| Admin | Panel admin + RBAC | Non inclus |
| Taille | Complet (~50 fichiers) | Léger (~30 fichiers) |
| Cas d'usage | SaaS complet | MVP rapide Supabase-first |

## Commandes

```bash
pnpm dev              # Dev server
pnpm build            # Build (migrate + next build)
pnpm db:generate      # Générer migrations Drizzle
pnpm db:migrate       # Appliquer migrations
pnpm db:push          # Push schema direct
pnpm db:studio        # Drizzle Studio (GUI)
pnpm stripe:setup     # Setup produits Stripe
pnpm stripe:listen    # Webhook listener local
```

## Variables d'environnement requises

- `NEXT_PUBLIC_SUPABASE_URL` - URL du projet Supabase
- `NEXT_PUBLIC_SUPABASE_ANON_KEY` - Clé anon Supabase
- `DATABASE_URL` - Connection string PostgreSQL
- `NEXT_PUBLIC_STRIPE_PRICING_TABLE_ID` - ID Pricing Table Stripe
- `NEXT_PUBLIC_STRIPE_PUBLISHABLE_KEY` - Clé publique Stripe
- `STRIPE_SECRET_KEY` - Clé secrète Stripe
- `STRIPE_WEBHOOK_SECRET` - Secret de signature du webhook (`whsec_...`, affiché par `stripe:listen` en local, dashboard Stripe en prod). Sans lui, la route refuse tous les webhooks.
- `GOOGLE_OAUTH_CLIENT_ID` / `SECRET` (optionnel)
- `GITHUB_OAUTH_CLIENT_ID` / `SECRET` (optionnel)

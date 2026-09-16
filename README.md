# Qulay Backend

Production REST API for the Qulay Distribution Business Control System. PostgreSQL is the canonical business-data store; browser LocalStorage is not used by this service.

## Stack

- Node.js 20.19+ and Express 5
- Prisma 7 with PostgreSQL/Neon
- JWT access tokens, rotating refresh tokens and device sessions
- bcrypt password and PIN hashes
- RBAC permissions plus employee module access
- Zod validation, pagination, search, sort and filters
- Multer and Sharp image processing
- Helmet, CORS allowlist, rate limiting, compression and request logs
- Swagger/OpenAPI 3.1
- Vitest and Supertest

## Implemented domains

- Company onboarding, branches, warehouses and settings
- Owner, admin and employee authentication; password/PIN login; reset/change password; logout and session revocation
- Roles, 72 granular permissions and employee module assignments
- Products, explicit barcodes, five-digit SKU sequence, variants, categories, units, price lists and images
- Warehouse balances, reservations, immutable stock movements, transfers, counts, adjustments and supplier goods receipts
- Customers, suppliers and nested contacts
- Orders, status history, reservation, picking, packing and completion
- POS held carts, cashboxes, payment methods, shifts, split payment, receipt generation and printing
- Invoices, customer/supplier payments, allocations, debts, cash transactions, currency rates and balanced ledger postings
- Delivery trips, full/partial/failed delivery, proof metadata and reservation consumption
- Returns, receiving and refunds with cumulative quantity protection
- Territories, route templates, route plans, visits, agents, KPI and salary payments
- Permission-aware dashboard, global search and notifications
- Audit log with actor, time, before/after values, IP, user-agent and request ID
- Idempotency-key replay protection for authenticated mutations

## Local setup

```bash
cp .env.example .env
npm ci
npm run prisma:generate
npm run prisma:migrate:deploy
npm run prisma:seed
npm run dev
```

The default API is `http://localhost:5000/api/v1`; Swagger UI is `http://localhost:5000/docs`.

- `GET /api/v1/health` is the process liveness probe and does not require PostgreSQL.
- `GET /api/v1/ready` verifies PostgreSQL and returns `503` until it is reachable.

## Authentication contract

Register the first owner with `POST /api/v1/auth/register-owner`. The transaction creates the trial company, owner role, owner employee, settings, main branch, warehouse, unit, price lists, cashbox and payment methods.

Password and PIN logins return an access token in the response. The refresh token is stored in a secure HTTP-only cookie and rotated on every refresh. Refresh-token reuse revokes all employee sessions. Access authentication rechecks the employee, company, session and token version against PostgreSQL.

For non-browser clients, `/auth/refresh` also accepts `refreshToken` in the JSON body. Set `credentials: "include"` in browser requests when using the cookie flow.

In production, configure `PASSWORD_RESET_WEBHOOK_URL` to deliver reset events to an email/SMS integration. The payload contains recipient information, the one-time token, expiry and an optional `FRONTEND_RESET_URL` link. Development responses include the token for local testing.

## Tenant and access boundaries

Every protected request takes `companyId` exclusively from its verified token/session. Client-supplied tenant values are ignored. Business queries scope IDs to the authenticated company before reads or mutations.

An employee needs both:

1. the module enabled in `EmployeeModule`; and
2. the relevant permission inherited from assigned roles.

Owner and admin roles bypass individual permission checks and receive all module keys. The `/auth/me` response is the frontend contract for sidebar, routes, dashboard, search, shortcuts, notifications and mobile navigation.

## API conventions

Success:

```json
{
  "success": true,
  "data": {},
  "meta": {},
  "requestId": "..."
}
```

Error:

```json
{
  "success": false,
  "error": {
    "code": "VALIDATION_ERROR",
    "message": "Request validation failed",
    "details": []
  },
  "requestId": "..."
}
```

List endpoints accept `page`, `limit`, `search`, `sortBy`, `sortOrder` and documented domain filters. The maximum generic page size is 100. Send a unique `Idempotency-Key` header for mutation retries; reuse with a different payload is rejected.

The OpenAPI source is `docs/openapi.yaml`. Swagger is enabled by default and can be disabled with `SWAGGER_ENABLED=false`.

## Database

The canonical schema is `prisma/schema.prisma`. The initial production migration is committed under `prisma/migrations`, and the idempotent seed synchronizes the permission catalog.

```bash
npm run prisma:validate
npm run prisma:migrate:deploy
npm run prisma:seed
```

Use the Neon pooled connection string as `DATABASE_URL` for runtime traffic. If the host contains `-pooler`, set `DIRECT_DATABASE_URL` to Neon’s session/direct connection string as well; migration deploys prefer it because PostgreSQL advisory locks require a stable session. No secret belongs in source control.

## Verification

```bash
npm run lint
npm run build
npm run test
npm run test:e2e
npm run check
```

`npm run build` regenerates Prisma Client and parses every backend JavaScript source file. Unit/smoke tests cover health/security responses, tenant isolation, JWT token types, RBAC/module behavior, account state, inventory invariants, product and route validation, and the OpenAPI contract. `npm run test:e2e` boots an isolated PostgreSQL-compatible PGlite server, applies the migration and verifies owner onboarding, catalog, opening stock, customer, shift, POS sale, receipt, stock balance, ledger balance and idempotency replay through HTTP.

## Render deployment

`render.yaml` defines the Node web service, migration/seed build command, health probe and persistent upload disk.

Before deploying:

1. set `DATABASE_URL` to the Neon pooled PostgreSQL URL;
2. set `DIRECT_DATABASE_URL` to the matching non-pooler Neon URL (required when the pooled URL cannot hold advisory locks);
3. set the exact frontend origin(s) in comma-separated `CORS_ORIGIN`;
4. allow Render to generate independent JWT secrets;
5. optionally configure `PASSWORD_RESET_WEBHOOK_URL` and `FRONTEND_RESET_URL`;
6. keep `/var/data/qulay-uploads` mounted, or implement/configure an external object-storage provider.

For horizontal scaling, images should move to S3-compatible storage; PostgreSQL business data remains canonical. Do not deploy with development secrets.

## Operational notes

- Graceful shutdown stops new connections and disconnects Prisma.
- Logs redact authorization, cookies, passwords, PINs and tokens.
- Uploads accept JPEG, PNG or WEBP, enforce a size limit, rotate metadata, resize and store WebP output with a checksum.
- Financial and stock mutations use database transactions; critical stock flows use serializable isolation.
- The audit log is append-only through API routes.

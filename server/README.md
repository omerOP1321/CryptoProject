# Auth & User-Management API

REST API backing the Crypto AI Prediction dashboard: registration, login/logout,
role-based authorization, and the admin-editable About page. Node + Express +
SQLite, with a layered architecture.

## Run

```bash
cd server
npm install
cp .env.example .env      # adjust as needed (ADMIN_PASSWORD, CORS_ORIGINS, ...)
npm run migrate           # create schema + seed admin + seed About content
npm start                 # http://localhost:4000
npm test                  # integration tests (node:test)
```

The static site (served on `http://localhost:8765`) talks to this API. The
frontend derives the API base from the page hostname, so serve both over the
same hostname (`localhost` **or** `127.0.0.1`) to keep the session cookie
same-site.

## Architecture (layered, scalable)

```
src/
  config.js              env-driven config (.env parser, no dep)
  app.js                 express assembly (security -> cors -> parse -> routes -> errors)
  index.js               entry: migrate, schedule session purge, listen
  db/
    schema.sql           DDL (applied idempotently on connect)
    index.js             single better-sqlite3 connection
    migrate.js           schema + seed (admin user, About content)
  routes/                HTTP layer (auth.routes, about.routes) — thin
  services/              business logic (auth.service, about.service)
  repositories/          data access — every query parameterized
  middleware/            validate (zod), auth, csrf, rateLimit, errorHandler
  utils/                 logger, errors (AppError)
tests/                   integration tests against an isolated temp DB
```

Request flow: **route → validate → service → repository → db**. Routes never
touch SQL; repositories never touch HTTP.

## REST endpoints

| Method | Path                | Auth            | Purpose                          |
|--------|---------------------|-----------------|----------------------------------|
| GET    | `/api/health`       | public          | liveness                         |
| POST   | `/api/auth/register`| public          | create account + start session   |
| POST   | `/api/auth/login`   | public          | start session                    |
| POST   | `/api/auth/logout`  | session + CSRF  | end session                      |
| GET    | `/api/auth/me`      | public          | current user + CSRF token        |
| POST   | `/api/auth/verify-email`        | token (link)        | confirm an email address     |
| POST   | `/api/auth/resend-verification` | session + CSRF      | resend verification (throttled) |
| POST   | `/api/auth/forgot-password`     | public (no enum)    | request a reset link         |
| POST   | `/api/auth/reset-password`      | token (link)        | set a new password           |
| GET    | `/api/about`        | public          | About markdown                   |
| PUT    | `/api/about`        | `about:edit` + verified + CSRF | update About markdown (admin + semi_admin) |
| GET    | `/api/users`        | `users:read`    | list users (admin + semi_admin, read-only) |
| PUT    | `/api/users/:id/role` | `users:manage` + CSRF | change a role (admin only)            |
| DELETE | `/api/users/:id`    | `users:manage` + CSRF | delete a user (admin only)            |

## Security controls

- **Passwords**: bcrypt (cost 12, configurable). Never stored or logged in plaintext.
- **Sessions**: opaque random token in an `httpOnly` + `SameSite=Lax` cookie; only
  the SHA-256 of the token is stored, so a DB leak can't be replayed. Server-side
  expiry + hourly purge.
- **CSRF**: per-session token required in `X-CSRF-Token` for authenticated state
  changes (timing-safe compare). Login/register rely on SameSite + CORS + rate limit.
- **SQL injection**: every query is a parameterized prepared statement.
- **XSS**: API returns JSON only; About content is rendered client-side with an
  escape-then-format markdown pass (no raw HTML is ever emitted).
- **Input validation**: zod schemas allow-list inputs (username charset, email,
  password complexity) and reject control/forbidden characters; JSON body capped at 64kb.
- **Rate limiting**: per-identifier failed-login throttle (locks after N fails /
  window) + coarse per-IP cap on auth endpoints; verification/reset requests have a
  resend cooldown + per-window cap.
- **One-time tokens**: email-verification & password-reset tokens are
  cryptographically random; only their SHA-256 is stored; single-use (`used_at`)
  with short expiry (verify 24h, reset 30m); issuing a new one invalidates older.
  Password reset also invalidates all of that user's sessions.
- **No user enumeration**: `forgot-password` always responds identically whether or
  not the email exists; login uses a generic error + dummy-hash timing.
- **Email verification**: `requireVerified` gates protected writes; unverified users
  can browse but not perform protected actions.
- **Authorization (RBAC)**: permissions declared per role in `utils/permissions.js`;
  routes ask for a permission via `requirePermission(...)`, never a role name.
- **Error handling**: operational errors return safe messages; anything else is a
  generic 500 — no stack traces, SQL, or internals leak.
- **Headers**: helmet.

## Roles & RBAC

Three roles, each mapped to permissions in `src/utils/permissions.js`:

| Role | Permissions |
|------|-------------|
| `user` | (read-only site) |
| `semi_admin` | `about:edit`, `users:read` (read-only admin overview) |
| `admin` | `about:edit`, `users:read`, `users:manage` (full user management) |

Adding a role or permission is a one-line change in that map — call sites
(`requirePermission('about:edit')`, etc.) don't change. Self-protection guards
prevent deleting/demoting your own account or removing the last admin.

## Email delivery

If `SMTP_HOST` is set, mail is sent via nodemailer. Otherwise a **dev transport**
logs each message and writes it to `data/outbox/`, and (in non-production) the
verification/reset API responses include a `devLink` so the flow is testable
without a mailbox. Configure via `MAIL_FROM`, `SMTP_*`, `APP_BASE_URL`,
`VERIFY_TTL_HOURS`, `RESET_TTL_MIN`, `RESEND_COOLDOWN_SEC` (see `.env.example`).

## Designed for future per-user data (Part C)

The `users` table is the stable anchor (`users.id`). Saving per-user data later
(e.g. investment simulations) is a new table referencing `users(id)` — **no change
to existing tables**. Sessions already key off `user_id`.

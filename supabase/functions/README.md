# Supabase Edge Functions

## `simulate` — Investment Simulation backend (Task 6)

All financial math for the Investment page (`website/investment.html`) runs here,
on Deno, server-side. The browser only sends parameters and renders the response.

```
supabase/functions/
  simulate/index.ts        router: simulate | leaderboard | save | list | delete
  _shared/engine.ts        pure simulation engine (long/short, all metrics, B&H, portfolio)
  _shared/engine_test.ts   deno tests for the engine
  _shared/cors.ts          shared CORS headers
```

### Test the engine

```bash
deno test supabase/functions/
```

### Deploy

Requires the [Supabase CLI](https://supabase.com/docs/guides/cli) (`brew install supabase/tap/supabase`).

```bash
# one-time
supabase login
supabase link --project-ref iphxmjltsigsaocicipu

# database: create the saved_simulations table + RLS
#   (or paste supabase/simulations_setup.sql into Studio -> SQL Editor)
supabase db push   # if using migrations, otherwise run the SQL file manually

# deploy the function
supabase functions deploy simulate
```

`SUPABASE_URL`, `SUPABASE_ANON_KEY` and `SUPABASE_SERVICE_ROLE_KEY` are injected
automatically by the platform — no secrets to set. The function reads the
prediction `payload` with the service-role key and reads/writes
`saved_simulations` through the caller's JWT so RLS enforces per-user ownership.

### Actions (POST JSON body)

| `action` | Auth | Body | Returns |
|----------|------|------|---------|
| `simulate` (default) | none | `coin, initialAmount, startDate?, endDate?, allocation?` | ranked `models[]` + `buyHold` + `portfolio?` (with curves) |
| `leaderboard` | none | `coin, initialAmount?, startDate?, endDate?` | ranked `models[]` (no curves) |
| `save` | JWT | `name, coin, initialAmount, startDate?, endDate?, allocation?` | the stored row |
| `list` | JWT | — | the user's `saved[]` |
| `delete` | JWT | `id` | `{ deleted }` |

`startDate` / `endDate` accept a unix-seconds number or any `Date.parse`-able
string. `allocation` is `[{ model, weight }]`; weights are normalised to sum to 1.

> Academic tool: returns **raw gross performance** — no fees, slippage or
> financing. The engine keeps a `fee` knob for extensibility but the API never
> sets it.

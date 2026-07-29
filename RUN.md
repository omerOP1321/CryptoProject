# Running the Crypto AI Engine

This engine generates the predictions that the website displays. It pushes results
to Supabase every few minutes; **the website only updates while the engine is running.**

You can run it two ways:

| Mode | What it does | Use when |
|------|--------------|----------|
| **Foreground** | Runs in a visible window; stop with `Ctrl+C` | You want to watch it / run it occasionally |
| **Background service** | Runs 24/7, auto-starts on login, auto-restarts on crash | You want the website always up to date |

All launchers live in the **`serving/`** folder.

---

## Before the first run — one-time requirements

1. **Python 3.12+** installed
   - macOS: <https://www.python.org/downloads/> (or `brew install python`)
   - Windows: <https://www.python.org/downloads/> — **check "Add Python to PATH"** during install.
2. **Credentials** in the **`secrets/`** folder (private, **not** in git):
   - `secrets/credentials.json`, `secrets/token.json` (Google Drive)
   - `secrets/supabase_creds.json` (Supabase)

   See [`secrets/README.md`](secrets/README.md) — copy the `*.example.json` templates
   and fill in your values. The engine will not push to the database without them.

> The dependencies (PyTorch, pandas, etc.) are installed **automatically** the first
> time you run a launcher — you don't need to install anything by hand.

---

## Foreground (simple)

**macOS** — double-click **`serving/run_engine.command`**
(or in Terminal: `./serving/run_engine.command`)

**Windows** — double-click **`serving/run_engine.bat`**

The first run takes a few minutes (it creates the environment and installs deps).
After that it starts quickly. Output is shown on screen and saved to
`logs/engine_<date>.log`. Press **`Ctrl+C`** to stop.

---

## Background service (always-on, 24/7)

Run a foreground launcher **once** first (so the environment is set up), then:

**macOS** — double-click **`serving/service/install_service_mac.command`**
- Stop it later with `serving/service/uninstall_service_mac.command`

**Windows** — right-click **`serving/service/install_service_windows.bat`** → **Run as administrator**
- Stop it later with `serving/service/uninstall_service_windows.bat`

The service logs to `logs/service.log` and restarts automatically if it crashes or
when you log back in.

---

## Auth API (login, accounts, admin About editing)

Separate from the prediction engine: a small Node + Express + SQLite REST API
(in **`server/`**) that powers user registration/login, email verification,
password reset, the **About** page content, and admin user management.

- It only needs to run when you want **login / admin features on a LOCAL copy**
  of the site. The live Vercel site is unaffected by it (and would need the API
  deployed separately to use these features).
- The prediction engine above does **not** depend on this — keep your existing
  reboot routine for the live site.

**Start it (first run installs deps + initializes the database automatically):**

- **macOS** — double-click **`server/run_auth.command`** (or `./server/run_auth.command`)
- **Windows** — double-click **`server/run_auth.bat`**

It runs in the foreground on **http://localhost:4000**; stop with **`Ctrl+C`**.

**Use it locally:** open the site via **`http://localhost:8765`** (serve it with
`python3 -m http.server 8765 --directory website`). Use the **same hostname**
(`localhost`) for both so the login cookie stays same-site. Default admin login is
in `server/.env` (`ADMIN_USERNAME` / `ADMIN_PASSWORD`).

See **`server/README.md`** for the architecture, endpoints, and security notes.

---

## Prediction backup & restore

Every prediction is appended to `data/predictions_{SYMBOL}.jsonl` **before** the
Supabase push and fsync'd, so a DB outage (or an egress lockout like 12–15 Jul
2026) costs nothing: the engine keeps predicting and the journal keeps the record.

`serving/replay_journal.py` is the other half — it puts the journal back.

```bash
python serving/replay_journal.py --verify
```

| Command | What it does |
|---|---|
| `--verify` | Compare journal against the DB. Writes nothing. Run this after any outage. |
| `--dry-run` | Show exactly what a restore would add. Writes nothing. |
| *(no flag)* | Restore missing entries into Supabase (asks for confirmation). |
| `--snapshot` | Reverse: back up DB history the journal is missing into the journal. |
| `--coin BTCUSDT` | Limit to one symbol. Repeatable. |
| `--since 2026-07-12` | Limit the window (UTC date). Also `--until`. |

Only the two prediction-history series are touched; candles, the live
`predictions` block and `chosen_model` are left as the DB has them. On a
timestamp collision the DB value wins unless you pass `--prefer-journal`.

The journal is committed to git, so the local file is itself backed up. Run
`--snapshot` after any long stretch where the engine wrote history the journal
predates, then commit the result.

---

## Deploying the website

Two independent deploy targets. **Pushing to `main` is not enough** — check both.

### 1. Frontend (Vercel) — ⚠️ auto-deploy currently broken

`website/` is served from https://crypto-project-peach-three.vercel.app and is
*supposed* to redeploy on every push to `main`.

As of **2026-07-29 it does not.** The last `vercel[bot]` production deployment was
2026-07-18; 11 commits have landed since and none deployed. New commits receive no
status checks at all, so the webhook is not reaching Vercel. The live site is
serving 11-day-old assets.

Check before claiming a frontend change is live:

```bash
gh api repos/omerOP1321/CryptoProject/deployments --jq '.[0].created_at'
```

If that timestamp predates your commit, the site does **not** have your change,
however green the push looked. Confirm by content, not by version string:

```bash
curl -s https://crypto-project-peach-three.vercel.app/index.html | grep -c _v2_5m
```

To fix: open the Vercel dashboard for the project (it sits under the
**omerOP1321** account, not `ofirzohar11`), then Settings → Git and reconnect the
repository; or trigger Deployments → Redeploy manually. If manual works but
automatic does not, the GitHub webhook is dead — repo Settings → Webhooks. Worth
ruling out a plan/usage limit too, given the Supabase egress lockout in July.

### 2. Investment backend (Supabase Edge Function)

The Investment page calls the `simulate` Edge Function, which keeps its **own**
model allow-list. Add a model to the dashboard without deploying this and the page
fails with `Unknown model: <name>`.

```bash
supabase login
```

```bash
supabase functions deploy simulate
```

Run the tests first — they cover the horizon and candle-key conventions that must
stay in step with `website/chart-utils.js`:

```bash
deno test supabase/functions/_shared/
```

---

## Files

| File | Purpose |
|------|---------|
| `serving/run_engine.command` / `.bat` | Foreground launchers (Mac / Windows) |
| `serving/replay_journal.py` | Verify / restore predictions from the local journal |
| `data/predictions_*.jsonl` | Append-only prediction journal (the durable record) |
| `server/run_auth.command` / `.bat` | Auth API launchers (Mac / Windows) |
| `server/` | Auth + user-management REST API (Node/Express/SQLite) |
| `serving/service/install_service_*` | Install the always-on background service |
| `serving/service/uninstall_service_*` | Remove the background service |
| `requirements.txt` | Python dependencies (installed automatically) |
| `serving/inference_orchestrator.py` | The engine itself (generated from the notebook) |
| `secrets/` | Your private credentials (not committed) |
| `logs/` | Run logs (not committed to git) |

> `serving/inference_orchestrator.py` is generated from
> `serving/inference_orchestrator.ipynb`. If you change the notebook, re-sync with:
> `jupyter nbconvert --to script serving/inference_orchestrator.ipynb`

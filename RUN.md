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

## Files

| File | Purpose |
|------|---------|
| `serving/run_engine.command` / `.bat` | Foreground launchers (Mac / Windows) |
| `serving/service/install_service_*` | Install the always-on background service |
| `serving/service/uninstall_service_*` | Remove the background service |
| `requirements.txt` | Python dependencies (installed automatically) |
| `serving/inference_orchestrator.py` | The engine itself (generated from the notebook) |
| `secrets/` | Your private credentials (not committed) |
| `logs/` | Run logs (not committed to git) |

> `serving/inference_orchestrator.py` is generated from
> `serving/inference_orchestrator.ipynb`. If you change the notebook, re-sync with:
> `jupyter nbconvert --to script serving/inference_orchestrator.ipynb`

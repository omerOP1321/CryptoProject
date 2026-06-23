# Running the Crypto AI Engine

This engine generates the predictions that the website displays. It pushes results
to Supabase every few minutes; **the website only updates while the engine is running.**

You can run it two ways:

| Mode | What it does | Use when |
|------|--------------|----------|
| **Foreground** | Runs in a visible window; stop with `Ctrl+C` | You want to watch it / run it occasionally |
| **Background service** | Runs 24/7, auto-starts on login, auto-restarts on crash | You want the website always up to date |

---

## Before the first run — one-time requirements

1. **Python 3.12+** installed
   - macOS: <https://www.python.org/downloads/> (or `brew install python`)
   - Windows: <https://www.python.org/downloads/> — **check "Add Python to PATH"** during install.
2. **Credentials files** in the project folder (these are private and **not** included in git):
   - `credentials.json`, `token.json` (Google Drive)
   - `supabase_creds.json` (Supabase)

   Copy these from the project owner. The engine will not start without them.

> The dependencies (PyTorch, pandas, etc.) are installed **automatically** the first
> time you run a launcher — you don't need to install anything by hand.

---

## Foreground (simple)

**macOS** — double-click **`run_engine.command`**
(or in Terminal: `./run_engine.command`)

**Windows** — double-click **`run_engine.bat`**

The first run takes a few minutes (it sets up the environment). After that it starts
quickly. Output is shown on screen and saved to `logs/engine_<date>.log`.
Press **`Ctrl+C`** to stop.

---

## Background service (always-on, 24/7)

Run a foreground launcher **once** first (so the environment is set up), then:

**macOS** — double-click **`service/install_service_mac.command`**
- Stop it later with `service/uninstall_service_mac.command`

**Windows** — right-click **`service/install_service_windows.bat`** → **Run as administrator**
- Stop it later with `service/uninstall_service_windows.bat`

The service logs to `logs/service.log` and restarts automatically if it crashes or
when you log back in.

---

## Files

| File | Purpose |
|------|---------|
| `run_engine.command` / `run_engine.bat` | Foreground launchers (Mac / Windows) |
| `service/install_service_*` | Install the always-on background service |
| `service/uninstall_service_*` | Remove the background service |
| `requirements.txt` | Python dependencies (installed automatically) |
| `inference_orchestrator.py` | The engine itself (generated from the notebook) |
| `logs/` | Run logs (not committed to git) |

> `inference_orchestrator.py` is generated from `inference_orchestrator.ipynb`.
> If you change the notebook, re-sync the script with:
> `jupyter nbconvert --to script inference_orchestrator.ipynb`

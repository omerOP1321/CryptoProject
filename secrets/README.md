# `secrets/` — credentials (NOT committed)

The engine and evaluation scripts read all credentials from this folder. The
**real** files here are gitignored; only the `*.example.json` templates and this
README are tracked.

## Files you need to place here

| File | What it is | How to get it |
|------|-----------|---------------|
| `supabase_creds.json` | Supabase URL + service-role key | Supabase dashboard → Project Settings → API |
| `credentials.json` | Google OAuth client (Desktop) for Drive | Google Cloud Console → APIs & Services → Credentials → OAuth client ID (Desktop) → download |
| `token.json` | Google OAuth token | **Auto-generated** on first local run after you authorize in the browser — you don't create this by hand |

Copy each `*.example.json` to the same name without `.example` and fill in your
values:

```bash
cp secrets/supabase_creds.example.json secrets/supabase_creds.json
cp secrets/credentials.example.json   secrets/credentials.json
# then edit both with your real values
```

## ⚠️ Running on Google Colab / Drive

When the engine runs on Colab it uses your Google Drive as the base directory, so
it looks for these files at **`<Drive>/CryptoProject/secrets/`**. If you run there,
create a `secrets/` folder on your Drive and put the same files in it.

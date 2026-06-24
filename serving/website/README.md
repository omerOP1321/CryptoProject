# `serving/website/` — dashboard frontend (move pending)

This folder is **prepared** but the website files have **not** been moved here yet.

The site currently lives at the repo root `website/` because it auto-deploys to
**Vercel**, and Vercel's project **Root Directory** setting points at `website/`.
Moving the files without updating Vercel would break the live deploy.

## To complete the move (do this manually)

1. In the Vercel dashboard → your project → **Settings → Build & Development →
   Root Directory**, change it from `website` to `serving/website`.
2. Then move the files:
   ```bash
   git mv website/* serving/website/
   git rmdir website 2>/dev/null || true
   ```
3. Redeploy and confirm the site still loads.

Until then, the live frontend remains at the repo-root [`website/`](../../website/).

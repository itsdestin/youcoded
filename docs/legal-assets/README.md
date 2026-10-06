# Legal page assets

These assets support the standalone legal pages, not the branch's homepage.

- `brand.png`: unchanged `https://youcoded.ai/brand/default-128.png`, retrieved October 6, 2026. The current live site's mascot mark is reused deliberately; no newer homepage commits were merged.
- `outfit-latin.woff2`: copied from this branch's `desktop/src/renderer/components/brand/outfit-latin.woff2` so the static pages can use the existing brand typeface without external requests.
- `OFL.txt`: Outfit's SIL Open Font License, from `https://raw.githubusercontent.com/google/fonts/main/ofl/outfit/OFL.txt`.

Legal wording and dates come only from root `PRIVACY.md` and `TERMS.md` via `docs/tools/gen-legal-pages.mjs`.

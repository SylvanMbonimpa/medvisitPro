# Front-end assets

The three pages under `medvisitpro/www/` (login, delegate, managers) used
to pull three things from the public internet on every page load:

- `cdn.tailwindcss.com` — the Tailwind **compiler**, which then rebuilt
  the stylesheet in the browser from an inline config
- `fonts.googleapis.com` — Inter
- `fonts.googleapis.com` — the full Material Symbols Outlined icon font

All three are now resolved at build time and served from the app's own
`/assets/medvisitpro/`. Inter was replaced by **IBM Plex Sans** in the
same pass.

## Rebuilding the CSS

```bash
npm install        # once
npm run build:css  # after any class or token change
```

**You must rebuild after adding a Tailwind class to a template or a JS
file.** Tailwind only emits CSS for classes it can find by scanning the
`content` globs in `tailwind.config.js`. This is the one behaviour that
differs from the old CDN, which compiled whatever it found at runtime —
forget the rebuild and the new class silently does nothing.

`npm run watch:css` rebuilds on save during development.

Class names must appear as complete literal strings to be found. This is
fine:

```js
const DOT = ["bg-primary", "bg-secondary"];
el.innerHTML = `<div class="${DOT[i % DOT.length]}"></div>`;
```

This is not — Tailwind never sees `bg-primary`, so it won't be in the
bundle:

```js
el.innerHTML = `<div class="bg-${color}"></div>`;  // don't
```

## Adding an icon

`public/fonts/material-symbols-subset.woff2` contains **only** the icons
the app currently renders — 41 of them, ~5KB against ~300KB for the full
face. A `material-symbols-outlined` span whose name isn't in the subset
renders as its literal ligature text ("delete", "person") rather than an
icon.

To add one, regenerate the subset with the full icon list plus the new
name:

```bash
# List the names currently in use
grep -rhoP '(?<=material-symbols-outlined[^>]{0,200}>)\s*[a-z_0-9]+\s*(?=<)' \
  medvisitpro/www/*.html medvisitpro/public/js/*.js | tr -d ' ' | sort -u

# Fetch the subset (comma-separated, no spaces), then download the woff2
# the returned CSS points at
curl -A "Mozilla/5.0" "https://fonts.googleapis.com/css2?\
family=Material+Symbols+Outlined:opsz,wght,FILL,GRAD@24,400,0,0\
&icon_names=add,close,delete,...&display=block"
```

Give the regenerated file a **new name** (`material-symbols-subset-2.woff2`)
and update the `@font-face` in `tailwind.css` to match. The `?v=` cache
buster applies to the stylesheet URL, not to the font URLs inside it, so
an overwritten file can sit in browser caches.

The same applies to `ibm-plex-sans-latin.woff2` /
`ibm-plex-sans-latin-ext.woff2` — only the latin and latin-ext ranges are
shipped (enough for English, French accents and Kinyarwanda); Cyrillic,
Greek and Vietnamese are omitted.

## A note on font weights

IBM Plex Sans' variable range stops at **700**, which is also the
heaviest weight the app asks for (`font-bold`; the type scale in
`tailwind.config.js` tops out at 600). Adding `font-extrabold` or
`font-black` would push past the range and the browser would synthesise
the weight by smearing the outlines — it looks visibly wrong. Use 700 as
the ceiling, or ship a heavier file.

## Layout

| Path | What |
|---|---|
| `tailwind.config.js` | Design tokens and content globs — the single source, replacing three inline copies |
| `styles/tailwind.css` | Build input: directives, `@font-face`, shared component classes |
| `medvisitpro/public/css/medvisitpro.css` | Built output. Committed, since deploys don't run npm |
| `medvisitpro/public/fonts/` | Self-hosted woff2 files |
| `medvisitpro/assets.py` | `asset_version()` — the `?v=` cache-busting token |

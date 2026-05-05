# GranularAV

Standalone Vite + React export of the `src/granular-av` instrument from the main `mscullywebsite` repo.

## Source of truth

Do not hand-edit this copy first. Regenerate it from the website repo with:

```bash
npm run export:granular-av
```

The export lands in `standalone/granular-av` by default.

## Local development

```bash
npm install
npm run dev
```

## GitHub Pages

This repo includes `.github/workflows/deploy.yml` for GitHub Pages via Actions.

Important: in GitHub, set **Settings -> Pages -> Source** to **GitHub Actions**. If Pages is left on **Deploy from a branch**, GitHub will serve the raw `index.html` and the app will fail with a 404 on `/src/main.tsx`.

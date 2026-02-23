# Studio X Wrestling - Jekyll + Tailwind

Production-ready Jekyll site styled with Tailwind (via PostCSS) and set up for GitHub Pages deployment through Actions.

## Prereqs
- Ruby 3.x with Bundler
- Node 18+

## Install
```bash
bundle install
npm install
```

## Develop
In one terminal, watch Tailwind:
```bash
npm run dev
```
In another, serve Jekyll with live reload:
```bash
bundle exec jekyll serve --livereload
```
The generated CSS is written to `assets/css/tailwind.css` (ignored in git).

## Build (local)
```bash
npm run build:css
JEKYLL_ENV=production bundle exec jekyll build
```

## Deploy (GitHub Pages via Actions)
The workflow `.github/workflows/gh-pages.yml` builds Tailwind, runs `jekyll build`, and publishes the `_site` folder with GitHub Pages. Ensure Pages is set to use GitHub Actions.

## Content
- Home, Coaches, Blog, Contact pages with WCAG-conscious semantics.
- Blog seeded with 3 training articles under `_posts`.
- SEO: `jekyll-seo-tag` plus JSON-LD (`SportsActivityLocation`).

## Assets
- Logo placed at `assets/images/logo.jpg`.
- Hero and section images use Unsplash placeholders (wrestling/gym/grappling). Replace with Hunter College photos as needed; keep alt text updated.

## Notes
- Colors pulled from the provided brand: yellow `#FFEA00`, black `#000000`, accent blue `#0055D4`, and white/off-white for contrast.
- Typography: Roboto Condensed for headings, Inter for body copy.

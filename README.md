# mysimplewebsite

## Signal loop

Visitor feedback posts to `/api/site-signal`, which dispatches the
`site_signal` GitHub workflow. The workflow prepares a normalized signal,
runs `openai/codex-action@main` with a chaos-generation prompt, validates the
result, opens a PR, auto-merges it, and triggers the Pages deploy.

GitHub Pages serves the static site. The feedback UI still records local
Automerge state there, but receiving live visitor signals requires hosting
`api/site-signal.js` on a serverless host such as Vercel or a small worker.

## GitHub Pages

The Pages workflow builds `src/script-source.js`, copies the static files into
`_site`, and deploys them to GitHub Pages.

Required Vercel secret:

- `SITE_SIGNAL_GITHUB_TOKEN`: GitHub token with repository dispatch permission.

Required GitHub Actions secret:

- `OPENAI_API_KEY`: used by `openai/codex-action` to generate new site versions.

Optional deployment variables:

- `GITHUB_OWNER`: defaults to `PerrinMyerson`
- `GITHUB_REPO`: defaults to `mysimplewebsite`
- `ALLOWED_ORIGIN`: CORS allowlist for the signal endpoint

Local checks:

```sh
npm run check
npm run validate
```

# mysimplewebsite

## Signal loop

Visitor feedback posts to `/api/site-signal`, which dispatches the
`site_signal` GitHub workflow. The workflow updates `data/site-lineage.json`,
builds `script.js`, opens a PR, and tries to auto-merge it.

GitHub Pages serves the static site. The feedback UI still records local
Automerge state there, but receiving live visitor signals requires hosting
`api/site-signal.js` on a serverless host such as Vercel or a small worker.

## GitHub Pages

The Pages workflow builds `src/script-source.js`, copies the static files into
`_site`, and deploys them to GitHub Pages.

Required deployment secret:

- `SITE_SIGNAL_GITHUB_TOKEN`: GitHub token with repository dispatch permission.

Optional deployment variables:

- `GITHUB_OWNER`: defaults to `PerrinMyerson`
- `GITHUB_REPO`: defaults to `mysimplewebsite`
- `ALLOWED_ORIGIN`: CORS allowlist for the signal endpoint

Local checks:

```sh
npm run check
```

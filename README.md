# nextrole

Daily UX & product design job radar for Israel.

**App:** https://shanilei.github.io/nextrole — install it from the browser menu ("Add to Home Screen").

Every morning a GitHub Action checks the job boards of the companies in `companies.json`, keeps the UX / product design roles located in Israel, and updates `data/jobs.json`. Roles that disappear from a board are marked `closed`.

## How it works

- **Sources:** public job-board APIs used by most Israeli tech companies — Greenhouse, Lever, Ashby, Workable, SmartRecruiters — plus Comeet's hosted careers pages. No scraping of LinkedIn.
- **Board detection:** a company can list `candidates` (board-name guesses). The collector tries each one on every supported ATS and caches the first hit in `data/boards.json`.
- **Filtering:** `scripts/lib/filters.mjs` decides what counts as a design role, what counts as Israel, and guesses the level (Junior / Mid / Senior+) from the title and the "N+ years" in the description.

## Files

| Path | What it is |
| --- | --- |
| `companies.json` | Companies to watch |
| `data/jobs.json` | Every tracked role, open and closed, with `firstSeen`, `lastSeen`, `level`, `minYears` |
| `data/boards.json` | Resolved ATS board per company |
| `data/report.json` | Last run: per-company status, counts, errors |
| `data/manual.json` | Hand-picked roles (e.g. from LinkedIn) shown alongside collected ones |
| `app/` | The web app (placeholder UI until the Figma design lands), deployed to GitHub Pages |

## Run it

```bash
npm test          # filter tests
npm run collect   # fetch boards and update data/
```

Requires Node 20+. No dependencies.

## Add a company

Add an entry to `companies.json`:

```json
{ "name": "Acme", "candidates": ["acme", "acmeinc"] }
```

or, when you know the board:

```json
{ "name": "Acme", "ats": "greenhouse", "id": "acme" }
```

Comeet boards use `"id": "<company-slug>/<company-uid>"` from the company's comeet.com/jobs URL.

## Roadmap

1. ~~Daily collector~~
2. ~~Installable web app on GitHub Pages~~ (status and notes saved per device)
3. Supabase to sync status and notes across devices
4. Final UI from Figma
5. Fit score per role with Claude

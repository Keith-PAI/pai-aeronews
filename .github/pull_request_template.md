# PR Checklist (PAI AeroNews)

## What changed (1–3 bullets)
- 

## Scope control
- [ ] This PR is **one concern** (not a grab bag)
- [ ] No generated artifacts included (e.g., `dist/`, `news-data.json`, `index.html`, counters)

## Deployment model guardrails
- [ ] No CI changes that cause pushes to `main`
- [ ] If workflow changes are necessary, they are isolated and justified (include rationale below)

## Cost safety (Gemini)
- [ ] Any Gemini call path is guarded by `canSpendGemini()`
- [ ] `recordGeminiCalls(1)` is called **exactly once per HTTP attempt**
- [ ] No silent cost paths / no double-counting

## Git hygiene
- [ ] I ran `gh pr diff <num> --name-only` (or reviewed file list) before requesting review
- [ ] If I rebased/cherry-picked: I verified no `dist/` or workflow conflicts were accidentally kept

## Notes for reviewer
- Rationale / gotchas / testing notes:

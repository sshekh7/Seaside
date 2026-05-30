# Seaside — Decisions

A running log of decisions made while scoping the project. Each entry is
short: the question, the choice, and the reasoning. New decisions get
appended.

---

## D1. One shared world

- **Question:** One global world or one world per cohort / user?
- **Choice:** One global world.
- **Why:** Matches the "trigger next day" being a single global event.
  Drastically simpler data model and admin surface. Every signed-up user
  inhabits the same Seattle.

## D2. Sim-day clock — Uniform / Weighted toggle

- **Question:** How do we compress a sim day into ~5 minutes of real time?
- **Choice:** Both, switchable in the UI. Stationary beats (`work`, `home`,
  `sleep`, `leisure`) are eligible for hard compression in Weighted mode;
  movement plays at full speed.
- **Why:** Uniform is "true" but boring during long work blocks. Weighted
  keeps motion legible without lying about the order or timing of events.

## D3. Fixed virtual calendar

- **Question:** Does sim time track real time, or is it its own thing?
- **Choice:** Fixed virtual calendar. Day 1 = a real date we pick (e.g.
  June 1, 2026), day N = day 1 + (N-1). World event prompts can reference
  whatever is happening in the real world on that virtual date.
- **Why:** Decouples "when we generate a day" from "what day it is in the
  sim". Backfill stays sane.

## D4. LLM provider abstraction

- **Question:** Azure OpenAI or AWS Bedrock?
- **Choice:** Both, behind `lib/llm.ts`. `LLM_PROVIDER=azure` during
  development (we have Azure credits); `LLM_PROVIDER=bedrock` for the
  hackathon judging deploy.
- **Why:** Hackathon requires AWS, but Azure is what we have credits for now.
  One env var swap is cheap insurance.

## D5. Retry / failure policy

- **Question:** What happens when an LLM call fails?
- **Choice:** 3 attempts with exponential backoff (1s/2s/4s). If the
  skeleton call exhausts retries, a coin flip picks between
  **reuse-yesterday** (repeat shifted plan, "quiet repeat day" diary) and
  **stayed-home** (single all-day home beat). Geocode/directions failures
  degrade locally to "stay at previous location" filler. Diary failures
  ship a placeholder paragraph but the plan and map replay are fine.
- **Why:** We never want a single bad LLM response to fail the whole day.
  Two distinct fallbacks keep the world from feeling identical across
  failures.

## D6. Concurrency target — 10 in-flight agents

- **Question:** How many agents plan in parallel?
- **Choice:** 10 in-flight agent pipelines per day. Each pipeline runs its
  own LLM + Mapbox calls sequentially. Mapbox additionally throttled to
  ~5 req/sec process-wide.
- **Why:** Keeps Bedrock TPS + Mapbox QPS in budget without sacrificing
  wall-clock significantly. 1000 agents → ~10 min/day at this fan-out.

## D7. Chain of thought stored at two levels

- **Question:** How much of the agent's "thinking" do we persist?
- **Choice:** Per-beat `reasoning` (1 sentence) + per-day `thought_process`
  (paragraph). No separate deliberation log.
- **Why:** Beat reasoning explains the *what*; daily thought process
  captures the *why* across the day. Both are cheap to generate and round
  out the PDF and the in-app profile panel without blowing token budget.

## D8. Day length = waking hours, with night-owl exceptions

- **Question:** Does a sim day cover 24h or just waking hours?
- **Choice:** Sim day is wake → sleep (~16h typical). Personality can flip
  this — a night-shift worker plans 6pm → 10am. End-of-day state lands the
  agent wherever sleep happens; replay only shows the active window.
- **Why:** Most days don't need overnight choreography; allowing personas
  to override keeps the world heterogeneous.

## D9. Cold start (first sim day)

- **Question:** Where do agents start on day 1?
- **Choice:** At their `location_home`, with `agent_state` initialized to
  100 energy and empty notes. LLM context says "first day of the
  simulation; you just woke up."
- **Why:** Trivial bootstrap.

## D10. Mid-simulation signups — backfill to catch up

- **Question:** What does a new agent's history look like if they sign up
  on day 12?
- **Choice:** Generate plans for days 1..12 in order, then they're part of
  the live world from day 13 onward. Backfill runs async after the form is
  submitted; UI shows progress.
- **Why:** Every agent ends up with the same shape of data; downstream
  features (PDFs, map history) don't need special cases.

## D11. World event prompt = freeform text

- **Question:** Should world events be structured (location, radius, time)
  or freeform?
- **Choice:** Freeform text. Trust the LLM to filter relevance using the
  agent's persona (home, work, interests).
- **Why:** Demos better. The LLM is good enough at "is this near me?" with
  the agent context. Structured can be added later if it bites.

## D12. No inter-agent interaction

- **Question:** Can plans reference other agents (lunch with X)?
- **Choice:** No. Agents move through the same world but don't transact.
- **Why:** Coordination requires a second pass and conflict resolution.
  Visually, two dots coincidentally ending up at the same place is good
  enough for the demo.

## D13. PDF contents

- **Question:** What goes in the per-day PDF?
- **Choice:** First-person diary entry, beat-by-beat timeline, static map
  snapshot of the route. No raw chain-of-thought dump. No cumulative
  weekly PDF.
- **Why:** Readable for the end user; uses Box and Mapbox; matches the
  "memento of your agent's day" framing.

## D14. Scale targets

- **Question:** How many agents / days / users?
- **Choice:** 1000 agents, 30 sim days of history before the demo, ~20
  users signing up during the demo. Pre-demo backfill runs overnight.
- **Why:** Provides a rich world to browse without overrunning Mapbox or
  Bedrock budgets given §6 concurrency.

## D15. Apify / Box / AWS roles

- **Apify** — LinkedIn profile/search actor for seeding agents. Raw JSON
  archived to Box.
- **Box** — raw Apify dumps, per-day PDFs. Supabase only stores file IDs.
- **AWS** — Bedrock for LLM calls in production; Amplify hosts the Next
  app.
- **Why:** Every hackathon-required tool has a load-bearing job; none are
  decorative.

## D16. Geocode + directions caching

- **Question:** Are 300k+ Mapbox calls a problem?
- **Choice:** Cache both geocoding (`places_cache`) and directions
  (`routes_cache`) in Supabase. Route key is rounded coordinates + mode.
- **Why:** Expected ~10x hit rate with shared landmarks across agents.

## D17. Activity types — enum + freeform

- **Question:** Force the LLM into a small activity enum, or let it write
  anything?
- **Choice:** `activity` is freeform text; `activity_type` is a small enum
  (`commute | work | meal | errand | social | exercise | leisure | sleep
  | home | other`) used only for replay compression. LLM is told to pick
  `other` if nothing else fits.
- **Why:** Freeform keeps days varied and interesting; the enum is purely
  a mechanical signal for the renderer.

## D18. No auth — name-match PDF retrieval

- **Question:** How do users get their PDFs?
- **Choice:** No login. `/me` form takes first + last name; case-insensitive
  match against `agents.name` unlocks signed Box URLs for that agent's
  days.
- **Why:** Simplest possible flow. Collisions are unlikely at hackathon
  scale; if they happen, we display all matches and let the user pick.

## D19. User-created agents via existing `/agents/new`

- **Question:** Build a separate signup, or reuse the agent creator?
- **Choice:** Reuse `/agents/new`. Add a short questionnaire that maps into
  the existing fields (`personality`, `job_description`, etc.). User-created
  agents get `source = 'user'`.
- **Why:** One creation path. Apify-, LLM-, and user-generated agents
  share the same downstream pipeline.

## D20. Admin panel covers all manual workflows

- **Question:** What needs automating vs admin-button-able?
- **Choice:** Build an `/admin` page with: day list + status, trigger-next-day
  form, day-detail with per-agent retry, seed-agents (Apify), generate-agent
  (LLM), backfill an agent. No cron jobs, no realtime client.
- **Why:** Hackathon — operator-in-the-loop is faster to ship and
  debug-friendly during the event.

## D21. Smoke test before full backfill

- **Question:** Do we run the 30-day backfill immediately?
- **Choice:** No. Plan day 1 + day 2 for ~10 agents first; review the
  shape; expand to all 1000 agents for days 1–2; only then run the full
  30-day backfill.
- **Why:** Easier to catch prompt/format regressions early with a small
  cohort.

## D22. Client is not realtime

- **Question:** Should the map auto-advance to "now" if a new day is
  spawned?
- **Choice:** No. The map shows whatever day the user picks from the
  dropdown. New days appear in the dropdown on page refresh.
- **Why:** Avoids websocket plumbing and race conditions with in-flight
  planning. Matches "operator triggers the next day" model.

## D23. Bbox-bound geocoder + travel sanity cap (from experiment)

- **Question:** Can we trust Mapbox forward geocoding on raw LLM place
  names?
- **Choice:** No. Always pass `bbox`, `proximity`, and `country=us`;
  reject any returned (or cached) coord outside the metro bbox; cap any
  single Directions leg at 90 minutes and treat over-limit legs as
  "stayed put."
- **Why:** Experiment found `gpt-5.4-nano` produces plausible place
  names ("Building 99, Redmond", "Microsoft Campus Cafeteria") that
  Mapbox confidently resolves to North Dakota, India, eastern WA. One
  produced a 24h "drive" that crossed two calendar boundaries.

## D24. Deterministic compression replaces LLM repair for time overruns

- **Question:** When the day overflows the 23:30 budget, do we round-trip
  to the LLM for a fix?
- **Choice:** No. Run a deterministic pass: shift downstream beats when a
  single leg overflows; proportionally scale stationary stay durations
  with a 5min floor; tail-drop beats if scaling isn't enough.
- **Why:** The LLM consistently over-packs by 85–166 minutes (6/6 runs
  in the sweep). Deterministic compression fits every plan into the day
  budget without a second LLM call; faster, cheaper, more predictable.
  LLM repair is still available for malformed-skeleton recovery.

## D25. Auto-repair concatenated timestamps in the validator

- **Question:** The LLM occasionally emits
  `"2026-06-02T07:30:00-07:45:00-07:00"` (start+end fused). Retry, or
  repair?
- **Choice:** Both. Add an explicit "WRONG: do not do this" example in
  the system prompt AND extract the first valid ISO substring in the
  validator. With both, sweep success went from 3-attempt-on-Priyanshu
  to 1-attempt-on-all-6-plans.
- **Why:** Cheap insurance against the most common LLM encoding glitch.

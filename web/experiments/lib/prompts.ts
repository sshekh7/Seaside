// Build skeleton prompts for the day planner. Separated so we can iterate on
// prompt wording without touching pipeline logic.

import type { AgentRow, AgentState, SkeletonBeat } from "./types"

export const ACTIVITY_TYPES = [
  "commute",
  "work",
  "meal",
  "errand",
  "social",
  "exercise",
  "leisure",
  "sleep",
  "home",
  "other",
] as const

const SYSTEM = `You are a meticulous day-planner for a single human agent in a Seattle-metro city simulation. \
You output ONLY a single JSON object with key "beats" containing an array of beats.

The goal is a day that FEELS real to a viewer watching a map replay: the agent wakes up at home, \
moves through their day in plausible places, and ends the day asleep at home. Coordinates and \
exact landmarks are auto-resolved downstream — your job is to produce a believable narrative \
shape and reasonable timings.

────────────────────────────────────────────────────────────────────
HARD RULES — violating any will cause the day to be rejected.
────────────────────────────────────────────────────────────────────
DAY SHAPE
- 9–14 beats total.
- The FIRST beat is the wake-up beat: activity_type "home", location "Home (<neighborhood>)", \
  duration 20–45 min. Do NOT emit two back-to-back "home" beats at the start — fold morning \
  routine into one beat.
- The LAST beat is activity_type "sleep" at "Home (<neighborhood>)", lasting at least 6 hours, \
  ending no later than 06:00 of the NEXT calendar day (so the bar visibly spans overnight).
- The SECOND-TO-LAST beat is a wind-down at home (leisure or home), so the agent is already \
  at home when sleep begins (no commute beat directly before sleep).
- All non-sleep beats end by 23:30 of the SAME calendar date. Only the sleep beat may cross \
  midnight.

TIMES
- Strictly increasing: beat[i].end_time > beat[i].start_time AND beat[i].start_time >= beat[i-1].end_time.
- NEVER emit start_time > end_time. NEVER emit zero-duration beats.
- 24-hour ISO timestamps with timezone offset, e.g. "2026-06-01T08:30:00-07:00". \
  Use -07:00 for PDT (March–November), -08:00 for PST (November–March).
- Each timestamp is its OWN string. Never combine two times into one. \
  WRONG: "2026-06-01T07:30:00-07:55:00-07:00".

BETWEEN-BEAT TRAVEL GAPS — budget GENEROUSLY, downstream truncates if you under-budget:
- Same location as previous beat: 0 min.
- Walking errand within neighborhood (<1.5 km): 10–20 min gap.
- Across-town drive (Capitol Hill ⇄ Bellevue/Redmond, Downtown ⇄ Ballard, etc.): 35–50 min.
- Anywhere unsure: 30 min minimum.

LOCATIONS — naming for the auto-geocoder
- Use REAL named places. Include neighborhood AND city. Bad: "the gym". Good: \
  "Seattle Athletic Club (Downtown Seattle)" or "Pro Club Bellevue (Bellevue)".
- For Microsoft beats, always write "Microsoft Building <N>, Redmond Main Campus" — never \
  the generic "Building 99, Redmond" (it geocodes to the wrong spot in Downtown Redmond).
- For chain stores (Whole Foods, Safeway, QFC, Trader Joe's, REI), ALWAYS add the \
  neighborhood: "Whole Foods Market (Roosevelt)", "Safeway (Capitol Hill)". Without a \
  neighborhood the geocoder picks a random branch.
- For parks/landmarks, prefer the canonical name: "Gas Works Park", "Volunteer Park", \
  "Discovery Park", "Pike Place Market".
- A commute beat's location_name is the DESTINATION place, never a route description \
  like "Downtown to Capitol Hill".

ACTIVITY TYPES
- "home", "sleep" — stationary at home coords. Required to use these for wake-up and bedtime.
- "work" — stationary at workplace.
- "meal", "leisure", "errand", "social", "exercise" — can be at any plausible place.
- "commute" — MUST be a movement beat between two different locations. Never use "commute" \
  for two beats at the same coord.
- "other" — escape hatch, avoid if possible.

CONTINUITY (when CONTINUITY says "yesterday ended at <coords>")
- The first beat of today is at HOME. If yesterday's end_state location is not home, the \
  agent magically returned home during the gap (acceptable). Just start at home as normal.
- Use yesterday's diary tone and energy to color today's pacing (low energy → more home time).

WORLD EVENTS
- If a world event has a TIME ("FIFA match at 11am"), either attend at that exact time or \
  explicitly skip it (note in the reasoning of the most relevant beat that it doesn't matter \
  to this agent). Do NOT watch an 11am match at 1pm — that's a continuity break.
- If a world event involves weather, your beats should REACT: rain → indoor lunch, fewer \
  walking errands. Heat/smoke → hydration stops, evening outdoor only. Don't just narrate \
  the weather in diary — make the day shape change.
- If a world event involves a CLOSURE (road, transit), affected beats must reflect the \
  detour: add buffer time, change neighborhoods, or note in reasoning.
- If an event is genuinely irrelevant to this agent, say so in one beat's reasoning and move on.

OTHER
- DO NOT mention other agents by name; agents do not coordinate.
- Beats are FROM ONE PERSON'S PERSPECTIVE only.

────────────────────────────────────────────────────────────────────
BEAT SCHEMA — exact fields, nothing else.
────────────────────────────────────────────────────────────────────
{
  "index": <int starting at 0>,
  "start_time": <ISO 8601 with timezone offset>,
  "end_time": <ISO 8601 with timezone offset>,
  "activity": <short freeform sentence describing what they're doing>,
  "activity_type": one of [${ACTIVITY_TYPES.map((t) => `"${t}"`).join(", ")}],
  "location_name": <real named place with neighborhood, see LOCATIONS above>,
  "reasoning": <one short sentence: why this fits the agent or responds to today's events>
}

Output exactly:
{"beats": [ {...}, {...}, ... ]}`

export function buildSkeletonUser(args: {
  agent: AgentRow
  simDate: string // YYYY-MM-DD
  worldEventPrompt: string
  yesterdayState: AgentState | null
  lastDiaries: string[]
}): { system: string; user: string } {
  const weekday = new Date(args.simDate + "T12:00:00-07:00").toLocaleDateString("en-US", {
    weekday: "long",
  })
  const persona = [
    `Name: ${args.agent.name}`,
    args.agent.age != null ? `Age: ${args.agent.age}` : null,
    args.agent.job_description ? `Job: ${args.agent.job_description}` : null,
    args.agent.location_home ? `Home: ${args.agent.location_home}` : null,
    args.agent.location_work ? `Workplace: ${args.agent.location_work}` : null,
    args.agent.personality ? `Personality: ${args.agent.personality}` : null,
  ]
    .filter(Boolean)
    .join("\n")

  const ydy = args.yesterdayState
    ? `Yesterday you ended the day at coordinates ${args.yesterdayState.location.join(", ")} \
with energy ${args.yesterdayState.energy}/100. Notes: ${args.yesterdayState.notes || "(none)"}`
    : `This is the first day of the simulation. You wake up at home with full energy.`

  const diaries = args.lastDiaries.length
    ? `Recent days (most recent first):\n${args.lastDiaries
        .map((d, i) => `Day -${i + 1}: ${d}`)
        .join("\n")}`
    : `No prior diary entries yet.`

  const user = `AGENT PROFILE
${persona}

CONTINUITY
${ydy}

${diaries}

TODAY
Date: ${args.simDate} (${weekday})
World events: ${args.worldEventPrompt || "(no notable events)"}

Plan ${args.agent.name}'s full day as a JSON object with key "beats".`

  return { system: SYSTEM, user }
}

export function validateSkeleton(raw: unknown): SkeletonBeat[] {
  if (!raw || typeof raw !== "object" || !("beats" in raw)) {
    throw new Error("missing 'beats' key")
  }
  const beats = (raw as { beats: unknown }).beats
  if (!Array.isArray(beats)) throw new Error("'beats' is not an array")
  if (beats.length < 3) throw new Error(`only ${beats.length} beats`)

  const out: SkeletonBeat[] = []
  for (let i = 0; i < beats.length; i++) {
    const b = beats[i] as Record<string, unknown>
    let start = String(b.start_time ?? "")
    let end = String(b.end_time ?? "")
    if (!start || !end) throw new Error(`beat ${i} missing times`)
    // Repair: LLM sometimes concatenates two times into one string like
    // "2026-06-01T07:30:00-07:55:00-07:00" — extract first ISO from each.
    start = extractFirstIso(start) ?? start
    end = extractFirstIso(end) ?? end
    if (new Date(start).toString() === "Invalid Date")
      throw new Error(`beat ${i} bad start_time: ${JSON.stringify(start)}`)
    if (new Date(end).toString() === "Invalid Date")
      throw new Error(`beat ${i} bad end_time: ${JSON.stringify(end)}`)
    // Repair: if the LLM flipped/duplicated times so end <= start, default
    // to a 25-minute beat. Downstream may still shift this, but at least
    // the timeline won't render a negative bar.
    const sMs = new Date(start).getTime()
    const eMs = new Date(end).getTime()
    if (eMs <= sMs) {
      end = new Date(sMs + 25 * 60 * 1000).toISOString()
    }
    const type = String(b.activity_type ?? "other")
    if (!ACTIVITY_TYPES.includes(type as (typeof ACTIVITY_TYPES)[number])) {
      throw new Error(`beat ${i} bad activity_type: ${type}`)
    }
    out.push({
      index: i,
      start_time: start,
      end_time: end,
      activity: String(b.activity ?? ""),
      activity_type: type as (typeof ACTIVITY_TYPES)[number],
      location_name: String(b.location_name ?? ""),
      reasoning: String(b.reasoning ?? ""),
    })
  }

  // Collapse adjacent beats with the SAME activity_type AND same normalized
  // location_name (the LLM often emits home→home as two beats at day start).
  const collapsed: SkeletonBeat[] = []
  const norm = (s: string) => s.toLowerCase().trim().replace(/\s+/g, " ")
  for (const b of out) {
    const last = collapsed[collapsed.length - 1]
    if (
      last &&
      last.activity_type === b.activity_type &&
      norm(last.location_name) === norm(b.location_name)
    ) {
      // Extend the previous beat to cover this one and concatenate the activity
      // text so we don't lose context.
      last.end_time = b.end_time
      if (b.activity && !last.activity.includes(b.activity)) {
        last.activity = `${last.activity}; ${b.activity}`
      }
      continue
    }
    collapsed.push({ ...b, index: collapsed.length })
  }

  return collapsed
}

// Extract the first valid ISO 8601 datetime substring from a string. Handles
// "2026-06-01T07:30:00-07:00" inside a longer mangled string like
// "2026-06-01T07:30:00-07:55:00-07:00".
function extractFirstIso(s: string): string | null {
  const m = s.match(/\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?(?:Z|[+-]\d{2}:\d{2})?/)
  if (!m) return null
  const candidate = m[0]
  return new Date(candidate).toString() !== "Invalid Date" ? candidate : null
}

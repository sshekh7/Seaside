// Reset the world: regenerate every agent's plan for the full week using a
// DISTINCT world event per day. Days run sequentially (so per-agent continuity
// — yesterday's end_state + recent diaries — carries forward correctly), but
// all agents within a single day are planned in PARALLEL.
//
// Usage:
//   bun run experiments/04-reset-world.ts
//
// Env overrides:
//   CONCURRENCY=6   # max agents planned at once (default 6)

import "dotenv/config"
import { mkdirSync, readFileSync, writeFileSync } from "node:fs"
import { listAgents } from "./lib/agents"
import { completeJson, getLlmMs, resetLlmMs } from "./lib/llm"
import { geocode, getMapboxMs, resetMapboxMs, getCacheStats, resetCacheStats } from "./lib/mapbox"
import { buildSkeletonUser, validateSkeleton } from "./lib/prompts"
import { validateAndAttachTravel } from "./lib/validate"
import { generateDiary } from "./lib/diary"
import type { AgentDayPlan, AgentRow, AgentState, SkeletonBeat } from "./lib/types"

const CONCURRENCY = parseInt(process.env.CONCURRENCY || "6", 10)

// One distinct world event per simulated day. Seattle, early June 2026.
const DAYS: { sim_date: string; day_number: number; world_event: string }[] = [
  {
    sim_date: "2026-06-01",
    day_number: 1,
    world_event:
      "Sunny Monday in early June, high of 74F. FIFA World Cup group stage match (USA vs Wales) airs at 11am PDT — bars downtown open early. Light Rail closed between Westlake and University District 9am-3pm for maintenance.",
  },
  {
    sim_date: "2026-06-02",
    day_number: 2,
    world_event:
      "Grey, drizzly Tuesday with steady rain from 7am to 2pm, high of 58F. SR-520 bridge closed eastbound 9am-noon for emergency repair, snarling cross-lake traffic.",
  },
  {
    sim_date: "2026-06-03",
    day_number: 3,
    world_event:
      "Hot, clear Wednesday hitting 91F by mid-afternoon. Free outdoor concert at Gas Works Park from 6pm draws big crowds. Moderate air quality from distant BC wildfire smoke.",
  },
  {
    sim_date: "2026-06-04",
    day_number: 4,
    world_event:
      "Mild, partly cloudy Thursday, high of 68F. Citywide transit strike: all Metro buses and Link Light Rail suspended until 4pm. Rideshare surge pricing in effect.",
  },
  {
    sim_date: "2026-06-05",
    day_number: 5,
    world_event:
      "Warm, breezy Friday, high of 77F. Seattle Pride kickoff: Capitol Hill street fair and road closures along Broadway and Pike from 5pm. Festive, busy evening downtown.",
  },
  {
    sim_date: "2026-06-06",
    day_number: 6,
    world_event:
      "Overcast Saturday, high of 64F. Farmers markets in Ballard, Fremont, and the U-District in full swing. Mariners home game at T-Mobile Park at 1pm brings SoDo crowds.",
  },
  {
    sim_date: "2026-06-07",
    day_number: 7,
    world_event:
      "Calm, sunny Sunday, high of 72F. Quiet end-of-week day with no major disruptions. Lake Union sees heavy recreational boat and paddle traffic in the afternoon.",
  },
]

async function planOne(args: {
  agent: AgentRow
  sim_date: string
  day_number: number
  world_event: string
  yesterday_state: AgentState | null
  last_diaries: string[]
}): Promise<AgentDayPlan & { _ok: boolean }> {
  resetLlmMs()
  resetMapboxMs()
  resetCacheStats()
  const t0 = Date.now()

  const homeLoc = await geocode(args.agent.location_home || "Seattle WA")
  if (!homeLoc) throw new Error(`home geocode failed for ${args.agent.name}`)

  const { system, user } = buildSkeletonUser({
    agent: args.agent,
    simDate: args.sim_date,
    worldEventPrompt: args.world_event,
    yesterdayState: args.yesterday_state,
    lastDiaries: args.last_diaries,
  })

  let skeleton: SkeletonBeat[] = []
  let attempts = 0
  let lastErr: unknown = null
  for (let i = 0; i < 3; i++) {
    attempts++
    try {
      const raw = await completeJson<unknown>({
        system,
        user,
        maxTokens: 3000,
        temperature: 0.85,
      })
      skeleton = validateSkeleton(raw)
      break
    } catch (err) {
      lastErr = err
    }
  }
  if (skeleton.length === 0) {
    return {
      sim_date: args.sim_date,
      day_number: args.day_number,
      agent_id: args.agent.id,
      agent_name: args.agent.name,
      status: "failed",
      beats: [],
      diary: "",
      thought_process: "",
      end_state: { location: homeLoc, energy: 50, notes: String(lastErr) },
      world_event_prompt: args.world_event,
      generated_at: new Date().toISOString(),
      stats: {
        skeleton_attempts: attempts,
        repair_used: false,
        geocode_misses: 0,
        route_misses: 0,
        overflow_fixed_by_shift: 0,
        overflow_remaining: 0,
        compressed_to_fit_day: false,
        compressed_minutes_saved: 0,
        sleep_beat_synthesized: false,
        returned_home_before_sleep: false,
        llm_ms: getLlmMs(),
        mapbox_ms: getMapboxMs(),
        total_ms: Date.now() - t0,
      },
      _ok: false,
    }
  }

  const { beats, stats: vStats } = await validateAndAttachTravel(skeleton, homeLoc)

  let diary = ""
  let thought = ""
  try {
    const out = await generateDiary({
      agent: args.agent,
      simDate: args.sim_date,
      worldEventPrompt: args.world_event,
      beats,
    })
    diary = out.diary
    thought = out.thought_process
  } catch {
    // tolerate
  }

  const cacheStats = getCacheStats()
  const lastBeat = beats[beats.length - 1]
  return {
    sim_date: args.sim_date,
    day_number: args.day_number,
    agent_id: args.agent.id,
    agent_name: args.agent.name,
    status: "ready",
    beats,
    diary,
    thought_process: thought,
    end_state: { location: lastBeat.location, energy: Math.max(20, 100 - beats.length * 5), notes: "" },
    world_event_prompt: args.world_event,
    generated_at: new Date().toISOString(),
    stats: {
      skeleton_attempts: attempts,
      repair_used: false,
      geocode_misses: cacheStats.geocode_misses,
      route_misses: cacheStats.route_misses,
      overflow_fixed_by_shift: vStats.overflow_fixed_by_shift,
      overflow_remaining: vStats.overflow_remaining,
      compressed_to_fit_day: vStats.compressed_to_fit_day,
      compressed_minutes_saved: vStats.compressed_minutes_saved,
      sleep_beat_synthesized: vStats.sleep_beat_synthesized,
      returned_home_before_sleep: vStats.returned_home_before_sleep,
      llm_ms: getLlmMs(),
      mapbox_ms: getMapboxMs(),
      total_ms: Date.now() - t0,
    },
    _ok: true,
  }
}

// Run tasks with a bounded concurrency pool, preserving input order in results.
async function mapPool<T, R>(items: T[], limit: number, fn: (item: T, index: number) => Promise<R>): Promise<R[]> {
  const results: R[] = new Array(items.length)
  let next = 0
  async function worker() {
    while (true) {
      const i = next++
      if (i >= items.length) return
      results[i] = await fn(items[i], i)
    }
  }
  const workers = Array.from({ length: Math.min(limit, items.length) }, () => worker())
  await Promise.all(workers)
  return results
}

async function main() {
  const allAgents = await listAgents()

  // Optional scoping: set ONLY_SEEDED=1 to plan only the agents listed in
  // output/seeded-agents.json (the freshly created batch), leaving everyone
  // else's existing plans untouched.
  let agents = allAgents
  if (process.env.ONLY_SEEDED === "1") {
    const seededFile = process.env.SEEDED_FILE || "seeded-agents.json"
    const seededPath = new URL(`./output/${seededFile}`, import.meta.url).pathname
    const { ids } = JSON.parse(readFileSync(seededPath, "utf8")) as { ids: string[] }
    const idSet = new Set(ids)
    agents = allAgents.filter((a) => idSet.has(a.id))
    console.log(`[reset] ONLY_SEEDED=1 (${seededFile}) — scoped to ${agents.length} seeded agents (of ${allAgents.length} total)`)
  }

  console.log(`[reset] ${agents.length} agents × ${DAYS.length} days, concurrency=${CONCURRENCY}`)
  console.log(`[reset] agents: ${agents.map((a) => a.name).join(", ")}\n`)

  const outDir = new URL("./output/plans/", import.meta.url).pathname
  mkdirSync(outDir, { recursive: true })

  // Per-agent rolling continuity, carried forward across sequential days.
  const prevByAgent: Record<string, { state: AgentState | null; diaries: string[] }> = {}
  for (const a of agents) prevByAgent[a.id] = { state: null, diaries: [] }

  let okCount = 0
  let failCount = 0

  for (const day of DAYS) {
    const dayT0 = Date.now()
    console.log(`=== ${day.sim_date} (day ${day.day_number}) ===`)
    console.log(`    event: ${day.world_event}`)

    const plans = await mapPool(agents, CONCURRENCY, async (agent) => {
      const prev = prevByAgent[agent.id]
      try {
        const plan = await planOne({
          agent,
          sim_date: day.sim_date,
          day_number: day.day_number,
          world_event: day.world_event,
          yesterday_state: prev.state,
          last_diaries: prev.diaries,
        })
        return plan
      } catch (err) {
        console.log(`    [${agent.name}] THROW ${(err as Error).message}`)
        return null
      }
    })

    // Write files + roll continuity forward (done after the parallel batch so
    // continuity for the NEXT day reflects this day's results).
    for (let i = 0; i < agents.length; i++) {
      const agent = agents[i]
      const plan = plans[i]
      if (!plan) {
        failCount++
        continue
      }
      const safeName = agent.name.replace(/[^a-z0-9]+/gi, "-").toLowerCase()
      writeFileSync(`${outDir}${day.sim_date}-${safeName}.json`, JSON.stringify(plan, null, 2))
      if (plan._ok) {
        okCount++
        prevByAgent[agent.id] = {
          state: plan.end_state,
          diaries: [plan.diary, ...prevByAgent[agent.id].diaries].slice(0, 3),
        }
      } else {
        failCount++
      }
      const lastEnd = plan.beats.length
        ? new Date(plan.beats[plan.beats.length - 1].end_time).toLocaleTimeString("en-US", { hour12: false, timeZone: "America/Los_Angeles" })
        : "n/a"
      console.log(`    [${agent.name}] ${plan._ok ? "ok" : "FAIL"} beats=${plan.beats.length} last=${lastEnd} t=${(plan.stats.total_ms / 1000).toFixed(1)}s`)
    }
    console.log(`    (day done in ${((Date.now() - dayT0) / 1000).toFixed(1)}s)\n`)
  }

  console.log(`[reset] complete — ${okCount} ok, ${failCount} failed across ${agents.length * DAYS.length} plans`)
}

void main()

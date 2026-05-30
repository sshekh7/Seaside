// Sweep: run the planner across both agents, multiple days, multiple events.
// Aggregates stats so we can see reliability across runs.
//
// Usage: bun run experiments/02-sweep.ts
import "dotenv/config"
import { mkdirSync, writeFileSync } from "node:fs"
import { listAgents } from "./lib/agents"
import { complete, completeJson, getLlmMs, resetLlmMs } from "./lib/llm"
import { geocode, getMapboxMs, resetMapboxMs, getCacheStats, resetCacheStats } from "./lib/mapbox"
import { buildSkeletonUser, validateSkeleton } from "./lib/prompts"
import { validateAndAttachTravel } from "./lib/validate"
import { generateDiary } from "./lib/diary"
import type { AgentDayPlan, AgentRow, AgentState, SkeletonBeat } from "./lib/types"

void complete

const DAYS: { sim_date: string; day_number: number; world_event: string }[] = [
  {
    sim_date: "2026-06-01",
    day_number: 1,
    world_event:
      "Sunny Monday in early June. FIFA World Cup group stage match (USA vs Wales) airs at 11am PDT. Light Rail closed between Westlake and University District 9am-3pm.",
  },
  {
    sim_date: "2026-06-02",
    day_number: 2,
    world_event:
      "Tuesday with heavy rain across Seattle metro from 7am to 2pm. SR-520 bridge closed eastbound 9am-noon for emergency repair.",
  },
  {
    sim_date: "2026-06-03",
    day_number: 3,
    world_event:
      "Hot sunny Wednesday, 92F by 3pm. Free outdoor concert at Gas Works Park from 6pm. Air quality moderate due to wildfire smoke from BC.",
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

async function main() {
  const agents = await listAgents()
  console.log(`agents: ${agents.map((a) => a.name).join(", ")}`)
  const outDir = new URL("./output/plans/", import.meta.url).pathname
  mkdirSync(outDir, { recursive: true })

  const allStats: { agent: string; date: string; ok: boolean; attempts: number; beats: number; lastEnd: string; overflow: number; compressed: boolean; saved: number; total_ms: number }[] = []

  // Per-agent rolling continuity: yesterday's end_state and last few diaries.
  const prevByAgent: Record<string, { state: AgentState | null; diaries: string[] }> = {}
  for (const a of agents) prevByAgent[a.id] = { state: null, diaries: [] }

  for (const day of DAYS) {
    for (const agent of agents) {
      process.stdout.write(`[plan] ${day.sim_date} ${agent.name} ... `)
      try {
        const prev = prevByAgent[agent.id]
        const plan = await planOne({
          agent,
          sim_date: day.sim_date,
          day_number: day.day_number,
          world_event: day.world_event,
          yesterday_state: prev.state,
          last_diaries: prev.diaries,
        })
        const safeName = agent.name.replace(/[^a-z0-9]+/gi, "-").toLowerCase()
        writeFileSync(`${outDir}${day.sim_date}-${safeName}.json`, JSON.stringify(plan, null, 2))
        // Roll continuity forward for this agent.
        if (plan._ok) {
          prevByAgent[agent.id] = {
            state: plan.end_state,
            diaries: [plan.diary, ...prev.diaries].slice(0, 3),
          }
        }
        const lastEnd = plan.beats.length
          ? new Date(plan.beats[plan.beats.length - 1].end_time).toLocaleTimeString("en-US", { hour12: false, timeZone: "America/Los_Angeles" })
          : "n/a"
        console.log(
          `${plan._ok ? "ok" : "FAIL"} | attempts=${plan.stats.skeleton_attempts} beats=${plan.beats.length} last=${lastEnd} ovf=${plan.stats.overflow_fixed_by_shift}/${plan.stats.overflow_remaining} compressed=${plan.stats.compressed_to_fit_day} saved=${plan.stats.compressed_minutes_saved}min t=${(plan.stats.total_ms / 1000).toFixed(1)}s`,
        )
        allStats.push({
          agent: agent.name,
          date: day.sim_date,
          ok: plan._ok,
          attempts: plan.stats.skeleton_attempts,
          beats: plan.beats.length,
          lastEnd,
          overflow: plan.stats.overflow_remaining,
          compressed: plan.stats.compressed_to_fit_day,
          saved: plan.stats.compressed_minutes_saved,
          total_ms: plan.stats.total_ms,
        })
      } catch (err) {
        console.log(`THROW ${(err as Error).message}`)
      }
    }
  }

  console.log("\n=== SWEEP SUMMARY ===")
  console.table(allStats)
}

void main()

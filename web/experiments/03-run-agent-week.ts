// Run the planner for a single agent across one week (7 days) with rolling
// continuity. Mirrors the per-day pipeline in 02-sweep.ts but scoped to one
// agent so we can backfill a newly added user.
//
// Usage:
//   bun run experiments/03-run-agent-week.ts                 # defaults to Carter
//   bun run experiments/03-run-agent-week.ts "Carter Rabasa" # by name (substring, case-insensitive)
//   bun run experiments/03-run-agent-week.ts <agentId>       # by id

import "dotenv/config"
import { mkdirSync, writeFileSync } from "node:fs"
import { listAgents } from "./lib/agents"
import { completeJson, getLlmMs, resetLlmMs } from "./lib/llm"
import { geocode, getMapboxMs, resetMapboxMs, getCacheStats, resetCacheStats } from "./lib/mapbox"
import { buildSkeletonUser, validateSkeleton } from "./lib/prompts"
import { validateAndAttachTravel } from "./lib/validate"
import { generateDiary } from "./lib/diary"
import type { AgentDayPlan, AgentRow, AgentState, SkeletonBeat } from "./lib/types"

const TARGET = process.argv[2] || "Carter"
const START_DATE = process.env.START_DATE || "2026-06-01"
const NUM_DAYS = parseInt(process.env.NUM_DAYS || "7", 10)
const WORLD_EVENT =
  process.env.WORLD_EVENT ||
  "Sunny Monday in early June. FIFA World Cup group stage match (USA vs Wales) airs at 11am PDT. Light Rail closed between Westlake and University District for maintenance until 3pm."

function addDays(iso: string, n: number): string {
  const d = new Date(`${iso}T00:00:00Z`)
  d.setUTCDate(d.getUTCDate() + n)
  return d.toISOString().slice(0, 10)
}

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
  const needle = TARGET.toLowerCase()
  const agent =
    agents.find((a) => a.id === TARGET) ||
    agents.find((a) => a.name.toLowerCase().includes(needle))
  if (!agent) {
    console.error(`Agent "${TARGET}" not found. Available: ${agents.map((a) => a.name).join(", ")}`)
    process.exit(1)
  }
  console.log(`[week] agent=${agent.name} (${agent.id})  days=${NUM_DAYS} starting ${START_DATE}`)

  const outDir = new URL("./output/plans/", import.meta.url).pathname
  mkdirSync(outDir, { recursive: true })
  const safeName = agent.name.replace(/[^a-z0-9]+/gi, "-").toLowerCase()

  let prevState: AgentState | null = null
  let prevDiaries: string[] = []

  for (let i = 0; i < NUM_DAYS; i++) {
    const sim_date = addDays(START_DATE, i)
    const day_number = i + 1
    process.stdout.write(`[plan] ${sim_date} (day ${day_number}) ${agent.name} ... `)
    try {
      const plan = await planOne({
        agent,
        sim_date,
        day_number,
        world_event: WORLD_EVENT,
        yesterday_state: prevState,
        last_diaries: prevDiaries,
      })
      writeFileSync(`${outDir}${sim_date}-${safeName}.json`, JSON.stringify(plan, null, 2))
      if (plan._ok) {
        prevState = plan.end_state
        prevDiaries = [plan.diary, ...prevDiaries].slice(0, 3)
      }
      const lastEnd = plan.beats.length
        ? new Date(plan.beats[plan.beats.length - 1].end_time).toLocaleTimeString("en-US", { hour12: false, timeZone: "America/Los_Angeles" })
        : "n/a"
      console.log(
        `${plan._ok ? "ok" : "FAIL"} | attempts=${plan.stats.skeleton_attempts} beats=${plan.beats.length} last=${lastEnd} t=${(plan.stats.total_ms / 1000).toFixed(1)}s`,
      )
    } catch (err) {
      console.log(`THROW ${(err as Error).message}`)
    }
  }

  console.log(`\n[done] wrote ${NUM_DAYS} day(s) for ${agent.name} to ${outDir}`)
}

void main()

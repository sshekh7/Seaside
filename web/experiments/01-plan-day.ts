// End-to-end day planner experiment.
//
// Usage:
//   bun run experiments/01-plan-day.ts
//   bun run experiments/01-plan-day.ts <agentId>
//
// Loads agents from Supabase, plans one full day, saves JSON to
// experiments/output/plans/<sim_date>-<agent_name>.json.

import "dotenv/config"
import { mkdirSync, writeFileSync } from "node:fs"
import { listAgents, getAgent } from "./lib/agents"
import { complete, completeJson, getLlmMs, resetLlmMs } from "./lib/llm"
import { geocode, getMapboxMs, resetMapboxMs, getCacheStats, resetCacheStats } from "./lib/mapbox"
import { buildSkeletonUser, validateSkeleton } from "./lib/prompts"
import { validateAndAttachTravel } from "./lib/validate"
import { generateDiary } from "./lib/diary"
import type { AgentDayPlan, SkeletonBeat } from "./lib/types"

const SIM_DATE = process.env.SIM_DATE || "2026-06-01"
const DAY_NUMBER = parseInt(process.env.DAY_NUMBER || "1", 10)
const WORLD_EVENT =
  process.env.WORLD_EVENT ||
  "Sunny Monday in early June. FIFA World Cup group stage match (USA vs Wales) airs at 11am PDT. Light Rail closed between Westlake and University District for maintenance until 3pm."

async function main() {
  resetLlmMs()
  resetMapboxMs()
  resetCacheStats()
  const t0 = Date.now()

  // Pick agent
  const argId = process.argv[2]
  const agents = await listAgents()
  if (agents.length === 0) {
    console.error("No agents in Supabase.")
    process.exit(1)
  }
  const agent = argId ? await getAgent(argId) : agents[0]
  if (!agent) {
    console.error("Agent not found.")
    process.exit(1)
  }
  console.log(`[planner] agent=${agent.name} (${agent.id})`)
  console.log(`[planner] sim_date=${SIM_DATE} day=${DAY_NUMBER}`)
  console.log(`[planner] world_event=${WORLD_EVENT}\n`)

  // Resolve home/work to coordinates (cached)
  const homeLoc = await geocode(agent.location_home || "Seattle WA")
  if (!homeLoc) throw new Error(`Could not geocode home: ${agent.location_home}`)
  console.log(`[planner] home -> ${homeLoc.join(", ")}`)

  // Skeleton
  const { system, user } = buildSkeletonUser({
    agent,
    simDate: SIM_DATE,
    worldEventPrompt: WORLD_EVENT,
    yesterdayState: null,
    lastDiaries: [],
  })

  let skeleton: SkeletonBeat[] = []
  let attempts = 0
  let lastErr: unknown
  for (let i = 0; i < 3; i++) {
    attempts++
    try {
      console.log(`[skeleton] attempt ${i + 1}/3 ...`)
      const raw = await completeJson<unknown>({
        system,
        user,
        maxTokens: 3000,
        temperature: 0.85,
      })
      // Always dump raw response for debugging
      const debugDir = new URL("./output/debug/", import.meta.url).pathname
      mkdirSync(debugDir, { recursive: true })
      writeFileSync(`${debugDir}skeleton-attempt-${i + 1}.json`, JSON.stringify(raw, null, 2))
      skeleton = validateSkeleton(raw)
      console.log(`[skeleton] OK — ${skeleton.length} beats`)
      break
    } catch (err) {
      lastErr = err
      console.warn(`[skeleton] validation failed: ${(err as Error).message}`)
    }
  }
  if (skeleton.length === 0) {
    throw lastErr ?? new Error("skeleton failed")
  }

  console.log(`\n[skeleton] preview:`)
  for (const b of skeleton) {
    console.log(
      `  ${new Date(b.start_time).toLocaleTimeString("en-US", { hour: "numeric", minute: "2-digit" })}-${new Date(b.end_time).toLocaleTimeString("en-US", { hour: "numeric", minute: "2-digit" })} [${b.activity_type}] ${b.activity} @ ${b.location_name}`,
    )
  }

  // Validate + attach travel
  console.log(`\n[validate] geocoding + routing ...`)
  const { beats, stats } = await validateAndAttachTravel(skeleton, homeLoc)
  console.log(`[validate] overflow fixed by shift: ${stats.overflow_fixed_by_shift}, remaining: ${stats.overflow_remaining}`)
  if (stats.geocode_failures.length) {
    console.warn(`[validate] geocode failures: ${stats.geocode_failures.join(", ")}`)
  }

  // Diary
  console.log(`\n[diary] generating ...`)
  let diary = ""
  let thought = ""
  try {
    const out = await generateDiary({ agent, simDate: SIM_DATE, worldEventPrompt: WORLD_EVENT, beats })
    diary = out.diary
    thought = out.thought_process
    console.log(`[diary] OK (${diary.length} chars diary, ${thought.length} chars thought)`)
  } catch (err) {
    console.warn(`[diary] failed:`, (err as Error).message)
  }

  // End state
  const lastBeat = beats[beats.length - 1]
  const endState = {
    location: lastBeat.location,
    energy: Math.max(20, 100 - beats.length * 5),
    notes: "",
  }

  const cacheStats = getCacheStats()
  const plan: AgentDayPlan = {
    sim_date: SIM_DATE,
    day_number: DAY_NUMBER,
    agent_id: agent.id,
    agent_name: agent.name,
    status: "ready",
    beats,
    diary,
    thought_process: thought,
    end_state: endState,
    world_event_prompt: WORLD_EVENT,
    generated_at: new Date().toISOString(),
    stats: {
      skeleton_attempts: attempts,
      repair_used: false,
      geocode_misses: cacheStats.geocode_misses,
      route_misses: cacheStats.route_misses,
      overflow_fixed_by_shift: stats.overflow_fixed_by_shift,
      overflow_remaining: stats.overflow_remaining,
      compressed_to_fit_day: stats.compressed_to_fit_day,
      compressed_minutes_saved: stats.compressed_minutes_saved,
      sleep_beat_synthesized: stats.sleep_beat_synthesized,
      returned_home_before_sleep: stats.returned_home_before_sleep,
      llm_ms: getLlmMs(),
      mapbox_ms: getMapboxMs(),
      total_ms: Date.now() - t0,
    },
  }

  // Save
  const outDir = new URL("./output/plans/", import.meta.url).pathname
  mkdirSync(outDir, { recursive: true })
  const safeName = agent.name.replace(/[^a-z0-9]+/gi, "-").toLowerCase()
  const outPath = `${outDir}${SIM_DATE}-${safeName}.json`
  writeFileSync(outPath, JSON.stringify(plan, null, 2))
  console.log(`\n[saved] ${outPath}`)
  console.log(`\n[stats]`, plan.stats)
}

void (async () => {
  // Hush unused-import warning when using complete (kept for symmetry)
  void complete
  try {
    await main()
  } catch (err) {
    console.error("[fatal]", err)
    process.exit(1)
  }
})()

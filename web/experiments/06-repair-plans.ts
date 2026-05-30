// Repair failed plans. Scans output/plans for any file with status="failed"
// and re-plans just those (agent + date), reconstructing continuity from the
// agent's previous-day plan file. Low concurrency by default to stay under the
// Bedrock rate limit. Idempotent — re-run until zero failures remain.
//
// Usage:
//   bun run experiments/06-repair-plans.ts
//   CONCURRENCY=3 bun run experiments/06-repair-plans.ts

import "dotenv/config"
import { readdirSync, readFileSync, writeFileSync } from "node:fs"
import { listAgents } from "./lib/agents"
import { completeJson, getLlmMs, resetLlmMs } from "./lib/llm"
import { geocode, getMapboxMs, resetMapboxMs, getCacheStats, resetCacheStats } from "./lib/mapbox"
import { buildSkeletonUser, validateSkeleton } from "./lib/prompts"
import { validateAndAttachTravel } from "./lib/validate"
import { generateDiary } from "./lib/diary"
import type { AgentDayPlan, AgentRow, AgentState, SkeletonBeat } from "./lib/types"

const CONCURRENCY = parseInt(process.env.CONCURRENCY || "3", 10)
const PLANS_DIR = new URL("./output/plans/", import.meta.url).pathname

function prevDate(iso: string): string {
  const d = new Date(`${iso}T00:00:00Z`)
  d.setUTCDate(d.getUTCDate() - 1)
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
      const raw = await completeJson<unknown>({ system, user, maxTokens: 3000, temperature: 0.85 })
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
        skeleton_attempts: attempts, repair_used: false, geocode_misses: 0, route_misses: 0,
        overflow_fixed_by_shift: 0, overflow_remaining: 0, compressed_to_fit_day: false,
        compressed_minutes_saved: 0, sleep_beat_synthesized: false, returned_home_before_sleep: false,
        llm_ms: getLlmMs(), mapbox_ms: getMapboxMs(), total_ms: Date.now() - t0,
      },
      _ok: false,
    }
  }

  const { beats, stats: vStats } = await validateAndAttachTravel(skeleton, homeLoc)

  let diary = ""
  let thought = ""
  try {
    const out = await generateDiary({ agent: args.agent, simDate: args.sim_date, worldEventPrompt: args.world_event, beats })
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
      skeleton_attempts: attempts, repair_used: true,
      geocode_misses: cacheStats.geocode_misses, route_misses: cacheStats.route_misses,
      overflow_fixed_by_shift: vStats.overflow_fixed_by_shift, overflow_remaining: vStats.overflow_remaining,
      compressed_to_fit_day: vStats.compressed_to_fit_day, compressed_minutes_saved: vStats.compressed_minutes_saved,
      sleep_beat_synthesized: vStats.sleep_beat_synthesized, returned_home_before_sleep: vStats.returned_home_before_sleep,
      llm_ms: getLlmMs(), mapbox_ms: getMapboxMs(), total_ms: Date.now() - t0,
    },
    _ok: true,
  }
}

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
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, () => worker()))
  return results
}

type FailedPlan = { file: string; data: AgentDayPlan }

async function main() {
  const agents = await listAgents()
  const byId = new Map(agents.map((a) => [a.id, a]))

  // Collect failed plan files.
  const failed: FailedPlan[] = []
  for (const name of readdirSync(PLANS_DIR)) {
    if (!name.endsWith(".json")) continue
    const path = PLANS_DIR + name
    let data: AgentDayPlan
    try {
      data = JSON.parse(readFileSync(path, "utf8")) as AgentDayPlan
    } catch {
      continue
    }
    if (data.status === "failed") failed.push({ file: path, data })
  }

  if (failed.length === 0) {
    console.log("[repair] no failed plans — nothing to do.")
    return
  }
  console.log(`[repair] ${failed.length} failed plans, concurrency=${CONCURRENCY}`)

  const results = await mapPool(failed, CONCURRENCY, async ({ file, data }) => {
    const agent = byId.get(data.agent_id)
    if (!agent) {
      console.log(`    [skip] ${data.agent_name} ${data.sim_date} — agent not in DB`)
      return false
    }

    // Reconstruct continuity from the agent's previous-day plan file, if present.
    let yesterdayState: AgentState | null = null
    let lastDiaries: string[] = []
    const safeName = agent.name.replace(/[^a-z0-9]+/gi, "-").toLowerCase()
    const prevPath = `${PLANS_DIR}${prevDate(data.sim_date)}-${safeName}.json`
    try {
      const prev = JSON.parse(readFileSync(prevPath, "utf8")) as AgentDayPlan
      if (prev.status !== "failed") {
        yesterdayState = prev.end_state
        lastDiaries = prev.diary ? [prev.diary] : []
      }
    } catch {
      // no previous day — treat as fresh start
    }

    try {
      const plan = await planOne({
        agent,
        sim_date: data.sim_date,
        day_number: data.day_number,
        world_event: data.world_event_prompt,
        yesterday_state: yesterdayState,
        last_diaries: lastDiaries,
      })
      writeFileSync(file, JSON.stringify(plan, null, 2))
      console.log(`    [${plan._ok ? "ok" : "STILL FAILED"}] ${agent.name} ${data.sim_date} beats=${plan.beats.length}`)
      return plan._ok
    } catch (err) {
      console.log(`    [THROW] ${agent.name} ${data.sim_date} — ${(err as Error).message}`)
      return false
    }
  })

  const fixed = results.filter(Boolean).length
  console.log(`[repair] done — ${fixed}/${failed.length} repaired, ${failed.length - fixed} still failing.`)
}

void main()

import { NextRequest, NextResponse } from "next/server"
import { spawn } from "node:child_process"
import { existsSync, readFileSync } from "node:fs"
import { join } from "node:path"
import { createClient } from "@supabase/supabase-js"

const supabase = createClient(
  process.env.NEXT_PUBLIC_SUPABASE_URL!,
  process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY!
)

const PLANS_DIR = join(process.cwd(), "experiments", "output", "plans")

const activeJobs = new Set<string>()

function runPlanDay(agentId: string, day: number, cwd: string): Promise<void> {
  return new Promise((resolve, reject) => {
    const child = spawn("bash", [join(cwd, "scripts/run-plan.sh"), agentId], {
      cwd,
      env: {
        ...process.env,
        SIM_DATE: `2026-06-0${day}`,
        DAY_NUMBER: String(day),
        PATH: process.env.PATH || "/usr/local/bin:/usr/bin:/bin",
      },
      stdio: "pipe",
    })

    let stderr = ""
    child.stderr?.on("data", (d) => { stderr += d.toString() })
    child.on("close", (code) => {
      if (code === 0) resolve()
      else reject(new Error(`Day ${day} exit ${code}: ${stderr.slice(0, 200)}`))
    })
    child.on("error", reject)
    setTimeout(() => { child.kill(); reject(new Error(`Day ${day} timed out`)) }, 90000)
  })
}

async function generateWeekInBackground(agentId: string) {
  if (activeJobs.has(agentId)) return
  activeJobs.add(agentId)
  const cwd = process.cwd()

  try {
    const results = await Promise.allSettled(
      [1, 2, 3, 4, 5, 6, 7].map((day) => runPlanDay(agentId, day, cwd))
    )
    results.forEach((r, i) => {
      if (r.status === "fulfilled") console.log(`[plan-gen] day ${i + 1} done`)
      else console.error(`[plan-gen] day ${i + 1} failed:`, r.reason?.message?.slice(0, 100))
    })

    // Sync generated plan files → Supabase `plans` table so the
    // agent-daily-summary Edge Function (no filesystem access) can read them.
    const { data: agent } = await supabase
      .from("agents").select("name").eq("id", agentId).maybeSingle()

    if (agent?.name) {
      const slug = agent.name.toLowerCase().replace(/\s+/g, "-")
      for (let day = 1; day <= 7; day++) {
        const date = `2026-06-0${day}`
        const file = join(PLANS_DIR, `${date}-${slug}.json`)
        if (!existsSync(file)) continue
        try {
          const plan = JSON.parse(readFileSync(file, "utf-8"))
          await supabase.from("plans").upsert(
            { agent_id: agentId, sim_date: date, plan_data: plan, generated_at: plan.generated_at },
            { onConflict: "agent_id,sim_date" }
          )
          console.log(`[plan-gen] synced ${date}-${slug} → Supabase`)
        } catch (syncErr) {
          console.error(`[plan-gen] sync failed for ${date}-${slug}:`, syncErr)
        }
      }
    }
  } finally {
    activeJobs.delete(agentId)
  }
}

export async function POST(req: NextRequest) {
  const { agent_id } = await req.json()
  if (!agent_id) return NextResponse.json({ error: "agent_id required" }, { status: 400 })

  generateWeekInBackground(agent_id)
  return NextResponse.json({ status: "generating", agent_id })
}

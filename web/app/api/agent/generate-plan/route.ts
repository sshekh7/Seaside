import { NextRequest, NextResponse } from "next/server"
import { spawn } from "node:child_process"
import { join } from "node:path"

const activeJobs = new Set<string>()

function runPlanDay(agentId: string, day: number, cwd: string): Promise<void> {
  return new Promise((resolve, reject) => {
    const child = spawn("npx", ["tsx", "experiments/01-plan-day.ts", agentId], {
      cwd,
      env: {
        ...process.env,
        SIM_DATE: `2026-06-0${day}`,
        DAY_NUMBER: String(day),
        DOTENV_CONFIG_PATH: join(cwd, ".env.local"),
        NEXT_PUBLIC_MAPBOX_TOKEN: process.env.NEXT_PUBLIC_MAPBOX_TOKEN || "",
        NEXT_PUBLIC_SUPABASE_URL: process.env.NEXT_PUBLIC_SUPABASE_URL || "",
        NEXT_PUBLIC_SUPABASE_ANON_KEY: process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY || "",
        AWS_ACCESS_KEY_ID: process.env.BEDROCK_ACCESS_KEY_ID || process.env.AWS_ACCESS_KEY_ID || "",
        AWS_SECRET_ACCESS_KEY: process.env.BEDROCK_SECRET_ACCESS_KEY || process.env.AWS_SECRET_ACCESS_KEY || "",
        AWS_REGION: process.env.BEDROCK_REGION || process.env.AWS_REGION || "us-west-2",
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

    // Timeout after 90s
    setTimeout(() => { child.kill(); reject(new Error(`Day ${day} timed out`)) }, 90000)
  })
}

async function generateWeekInBackground(agentId: string) {
  if (activeJobs.has(agentId)) return
  activeJobs.add(agentId)
  const cwd = process.cwd()

  try {
    // Run all 7 days in parallel
    const results = await Promise.allSettled(
      [1, 2, 3, 4, 5, 6, 7].map((day) => runPlanDay(agentId, day, cwd))
    )
    results.forEach((r, i) => {
      if (r.status === "fulfilled") console.log(`[plan-gen] day ${i + 1} done`)
      else console.error(`[plan-gen] day ${i + 1} failed:`, r.reason?.message?.slice(0, 100))
    })
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

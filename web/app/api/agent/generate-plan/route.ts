import { NextRequest, NextResponse } from "next/server"
import { createClient } from "@supabase/supabase-js"
import { BedrockRuntimeClient, InvokeModelCommand } from "@aws-sdk/client-bedrock-runtime"
import { mkdirSync, writeFileSync, existsSync } from "node:fs"
import { join } from "node:path"

const supabase = createClient(
  process.env.NEXT_PUBLIC_SUPABASE_URL!,
  process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY!
)

const bedrock = new BedrockRuntimeClient({
  region: process.env.BEDROCK_REGION || process.env.AWS_REGION || "us-west-2",
  credentials: {
    accessKeyId: process.env.BEDROCK_ACCESS_KEY_ID || process.env.AWS_ACCESS_KEY_ID!,
    secretAccessKey: process.env.BEDROCK_SECRET_ACCESS_KEY || process.env.AWS_SECRET_ACCESS_KEY!,
  },
})

const MAPBOX_TOKEN = process.env.NEXT_PUBLIC_MAPBOX_TOKEN!
const PLANS_DIR = join(process.cwd(), "experiments", "output", "plans")

async function llm(system: string, user: string): Promise<string> {
  const body = JSON.stringify({
    anthropic_version: "bedrock-2023-05-31",
    max_tokens: 4096,
    temperature: 0.8,
    system,
    messages: [{ role: "user", content: user }],
  })
  const res = await bedrock.send(new InvokeModelCommand({
    modelId: "us.anthropic.claude-haiku-4-5-20251001-v1:0",
    contentType: "application/json",
    body: new TextEncoder().encode(body),
  }))
  const result = JSON.parse(new TextDecoder().decode(res.body))
  return result.content[0].text
}

async function geocode(place: string): Promise<{ lat: number; lng: number } | null> {
  try {
    const res = await fetch(
      `https://api.mapbox.com/search/geocode/v6/forward?q=${encodeURIComponent(place + ", Seattle WA")}&limit=1&access_token=${MAPBOX_TOKEN}`
    )
    const data = await res.json()
    const coords = data.features?.[0]?.geometry?.coordinates
    return coords ? { lng: coords[0], lat: coords[1] } : null
  } catch { return null }
}

async function generateDayPlan(agent: Record<string, unknown>, date: string, dayNumber: number) {
  const dayOfWeek = new Date(date + "T12:00:00").toLocaleDateString("en-US", { weekday: "long" })
  const isWeekend = ["Saturday", "Sunday"].includes(dayOfWeek)

  const system = `You are a day planner for a realistic human simulation. Generate a detailed daily schedule.`
  const user = `Create a realistic day plan for this person:
Name: ${agent.name}
Age: ${agent.age}
Job: ${agent.job_description}
Personality: ${agent.personality}
Home: ${agent.location_home}
Work: ${agent.location_work}
Day: ${dayOfWeek}, ${date} (Day ${dayNumber} of simulation)
${isWeekend ? "It's the weekend — no work unless their job requires it." : "It's a workday."}

Generate 8-12 activities for the full day (wake to sleep). Each activity needs:
- start_time (HH:MM 24h)
- end_time (HH:MM 24h)  
- activity (what they're doing)
- location (specific real place name in Seattle/Bellevue/Redmond area)
- type (one of: sleep, home, commute, work, meal, leisure, errand, social, exercise)

Respond with ONLY a JSON array, no markdown:
[{"start_time":"07:00","end_time":"07:30","activity":"...","location":"...","type":"..."},...]`

  const text = await llm(system, user)
  const cleaned = text.replace(/```json?\s*/g, "").replace(/```/g, "").trim()
  const match = cleaned.match(/\[[\s\S]*\]/)
  if (!match) throw new Error("Failed to parse schedule")

  const beats = JSON.parse(match[0])

  // Geocode locations and format with full ISO timestamps
  const geocoded = await Promise.all(
    beats.map(async (beat: Record<string, string>, idx: number) => {
      const loc = await geocode(beat.location)
      const toISO = (hhmm: string) => {
        const [h, m] = hhmm.split(":").map(Number)
        const d = new Date(date + "T00:00:00.000Z")
        d.setUTCHours(h, m, 0, 0)
        return d.toISOString()
      }
      return {
        index: idx,
        start_time: toISO(beat.start_time),
        end_time: toISO(beat.end_time),
        activity: beat.activity,
        activity_type: beat.type || "leisure",
        location_name: beat.location,
        location: loc ? { lat: loc.lat, lng: loc.lng } : null,
        travel_from_prev: null,
        reasoning: "",
      }
    })
  )

  return {
    sim_date: date,
    day_number: dayNumber,
    agent_id: agent.id,
    agent_name: agent.name,
    status: "ok",
    beats: geocoded,
    diary: "",
    thought_process: "",
    end_state: null,
    world_event_prompt: `Day ${dayNumber} of simulation. ${dayOfWeek} in Seattle.`,
    generated_at: new Date().toISOString(),
    stats: {},
  }
}

const activeJobs = new Set<string>()

async function generateWeekInBackground(agent: Record<string, unknown>) {
  const agentId = agent.id as string
  if (activeJobs.has(agentId)) return
  activeJobs.add(agentId)

  try {
    mkdirSync(PLANS_DIR, { recursive: true })
    const slug = (agent.name as string).toLowerCase().replace(/\s+/g, "-")

    for (let day = 1; day <= 7; day++) {
      const date = `2026-06-0${day}`
      const file = join(PLANS_DIR, `${date}-${slug}.json`)
      if (existsSync(file)) continue

      const plan = await generateDayPlan(agent, date, day)
      writeFileSync(file, JSON.stringify(plan, null, 2))
      console.log(`[plan-gen] saved ${date}-${slug}.json`)

      // Also upsert into Supabase so Edge Functions (which have no filesystem
      // access) can read plans for the daily-summary cron job.
      await supabase
        .from("plans")
        .upsert(
          { agent_id: agentId, sim_date: date, plan_data: plan, generated_at: plan.generated_at },
          { onConflict: "agent_id,sim_date" }
        )
    }
  } catch (err) {
    console.error(`[plan-gen] error for ${agent.name}:`, err)
  } finally {
    activeJobs.delete(agentId)
  }
}

export async function POST(req: NextRequest) {
  const { agent_id } = await req.json()
  if (!agent_id) return NextResponse.json({ error: "agent_id required" }, { status: 400 })

  const { data: agent, error } = await supabase
    .from("agents")
    .select("*")
    .eq("id", agent_id)
    .maybeSingle()

  if (error || !agent) return NextResponse.json({ error: "Agent not found" }, { status: 404 })

  generateWeekInBackground(agent)
  return NextResponse.json({ status: "generating", agent_id, message: "7-day plan generation started" })
}

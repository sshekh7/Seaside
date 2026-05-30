import { NextRequest, NextResponse } from "next/server"
import { Readable } from "stream"
import { getBoxClient } from "@/lib/box"

type BeatExport = {
  time: string
  activity: string
  activity_type: string
  location: string
  coordinates: [number, number]
  travel_mode: string | null
  travel_path: [number, number][] | null
  travel_duration_min: number | null
  reasoning: string
}

type DayExport = {
  date: string
  day_number: number
  diary: string
  world_event: string
  beats: BeatExport[]
}

type AgentExportPayload = {
  agentId: string
  agentName: string
  days: DayExport[]
}

const FOLDER_ID = process.env.BOX_FOLDER_ID ?? "0"

async function askBoxAI(fileId: string, token: string, agentName: string): Promise<string | null> {
  try {
    const res = await fetch("https://api.box.com/2.0/ai/ask", {
      method: "POST",
      headers: {
        Authorization: `Bearer ${token}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        mode: "single_item_qa",
        prompt: `This file contains ${agentName}'s full activity history across multiple simulation days.

Analyze it and provide a concise personal debrief covering:
1. How did ${agentName}'s daily routine change across days? (paths, destinations, timing)
2. Which locations did they visit most consistently vs. which varied?
3. Any days where their behavior was notably different — were they ever "late" or did they take unusual routes?
4. What does their travel pattern (walking/driving/cycling, route choices) reveal about their lifestyle?

Keep it to 5-7 sentences, written as a human-readable summary about this specific person.`,
        items: [{ type: "file", id: fileId }],
      }),
    })

    if (!res.ok) {
      console.error("[Box AI agent error]", res.status, await res.text())
      return null
    }

    const data = await res.json()
    return data.answer ?? null
  } catch (err) {
    console.error("[Box AI agent fetch error]", err)
    return null
  }
}

export async function POST(req: NextRequest) {
  try {
    const payload: AgentExportPayload = await req.json()

    if (!payload.agentId || !payload.agentName || !Array.isArray(payload.days)) {
      return NextResponse.json({ error: "Invalid payload" }, { status: 400 })
    }

    const exportedAt = new Date().toISOString()

    // Build a rich report with cross-day comparison data
    const report = {
      exportedAt,
      agent: {
        id: payload.agentId,
        name: payload.agentName,
      },
      totalDays: payload.days.length,
      summary: {
        totalBeats: payload.days.reduce((sum, d) => sum + d.beats.length, 0),
        uniqueLocations: [
          ...new Set(payload.days.flatMap((d) => d.beats.map((b) => b.location))),
        ],
        travelModes: [
          ...new Set(
            payload.days
              .flatMap((d) => d.beats.map((b) => b.travel_mode))
              .filter(Boolean),
          ),
        ],
      },
      days: payload.days.map((d) => ({
        date: d.date,
        day_number: d.day_number,
        world_event: d.world_event,
        diary: d.diary,
        route_summary: d.beats.map((b) => ({
          time: b.time,
          from_to: b.travel_mode
            ? `→ ${b.location} (${b.travel_mode}, ${b.travel_duration_min}min)`
            : `@ ${b.location}`,
          activity: b.activity,
          activity_type: b.activity_type,
          coordinates: b.coordinates,
          path_points: b.travel_path?.length ?? 0,
          reasoning: b.reasoning,
        })),
      })),
    }

    const json = JSON.stringify(report, null, 2)
    const filename = `agent-${payload.agentName.replace(/\s+/g, "-").toLowerCase()}-${exportedAt.replace(/[:.]/g, "-")}.json`

    const client = getBoxClient()
    const stream = Readable.from(Buffer.from(json, "utf-8"))
    const uploaded = await client.files.uploadFile(FOLDER_ID, filename, stream)
    const file = uploaded.entries[0]

    // Ask Box AI to analyze the agent's multi-day history
    const token = process.env.BOX_DEVELOPER_TOKEN!
    const aiSummary = await askBoxAI(file.id, token, payload.agentName)

    return NextResponse.json({
      success: true,
      fileId: file.id,
      fileName: file.name,
      boxUrl: `https://app.box.com/file/${file.id}`,
      aiSummary,
    })
  } catch (err: unknown) {
    const message = err instanceof Error ? err.message : "Unknown error"
    console.error("[Box agent export error]", message)
    return NextResponse.json({ error: message }, { status: 500 })
  }
}

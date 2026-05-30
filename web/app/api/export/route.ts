import { NextRequest, NextResponse } from "next/server"
import { Readable } from "stream"
import { getBoxClient } from "@/lib/box"

export type ActivityEntry = {
  name: string
  activity: string
  reasoning: string
  timestamp?: string
}

export type ExportPayload = {
  activities: ActivityEntry[]
  agentCount: number
  simTime: string
  exportedAt?: string
}

// The Box folder ID to upload into. "0" means the root folder.
// Set BOX_FOLDER_ID in .env.local to target a specific folder.
const FOLDER_ID = process.env.BOX_FOLDER_ID ?? "0"

async function askBoxAI(fileId: string, token: string): Promise<string | null> {
  try {
    const res = await fetch("https://api.box.com/2.0/ai/ask", {
      method: "POST",
      headers: {
        Authorization: `Bearer ${token}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        mode: "single_item_qa",
        prompt: `Analyze this city simulation export and provide a concise debrief covering:
1. Overall activity patterns — what were agents mostly doing?
2. Most active agents and what made them stand out
3. Any interesting or unexpected behaviors
4. Which city zones saw the most activity
Keep it to 4-6 sentences, written as a human-readable summary.`,
        items: [{ type: "file", id: fileId }],
      }),
    })

    if (!res.ok) {
      console.error("[Box AI error]", res.status, await res.text())
      return null
    }

    const data = await res.json()
    return data.answer ?? null
  } catch (err) {
    console.error("[Box AI fetch error]", err)
    return null
  }
}

export async function POST(req: NextRequest) {
  try {
    const payload: ExportPayload = await req.json()

    if (!payload.activities || !Array.isArray(payload.activities)) {
      return NextResponse.json({ error: "Invalid payload: activities array required" }, { status: 400 })
    }

    const exportedAt = new Date().toISOString()
    const report = {
      exportedAt,
      simTime: payload.simTime,
      agentCount: payload.agentCount,
      totalActivities: payload.activities.length,
      activities: payload.activities,
    }

    const json = JSON.stringify(report, null, 2)
    const filename = `simulation-${exportedAt.replace(/[:.]/g, "-")}.json`

    const client = getBoxClient()

    // Upload the simulation JSON to Box
    const stream = Readable.from(Buffer.from(json, "utf-8"))
    const uploaded = await client.files.uploadFile(FOLDER_ID, filename, stream)
    const file = uploaded.entries[0]

    // Ask Box AI to analyze the uploaded file
    const token = process.env.BOX_DEVELOPER_TOKEN!
    const aiSummary = await askBoxAI(file.id, token)

    return NextResponse.json({
      success: true,
      fileId: file.id,
      fileName: file.name,
      boxUrl: `https://app.box.com/file/${file.id}`,
      aiSummary,
    })
  } catch (err: unknown) {
    const message = err instanceof Error ? err.message : "Unknown error"
    console.error("[Box export error]", message)
    return NextResponse.json({ error: message }, { status: 500 })
  }
}

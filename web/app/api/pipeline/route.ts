import { NextResponse } from "next/server"
import { startScrape, getScrapeResults } from "@/lib/apify"
import { uploadJsonToBox, askBoxAI } from "@/lib/box"
import { supabase } from "@/lib/supabase"

// In-memory state for the current pipeline run
let currentRun: { runId: string; startedAt: string; query: string } | null = null
let lastResults: { items: unknown[] } | null = null

/** PATCH /api/pipeline — update Box token at runtime (with verification) */
let tokenSetAt: number | null = null

export async function PATCH(request: Request) {
  const { token } = await request.json() as { token?: string }
  if (!token) return NextResponse.json({ error: "token required" }, { status: 400 })

  // Verify token by calling Box API
  const res = await fetch("https://api.box.com/2.0/users/me", {
    headers: { Authorization: `Bearer ${token}` },
  })
  if (!res.ok) {
    return NextResponse.json({ error: "Invalid or expired token" }, { status: 401 })
  }

  process.env.BOX_DEVELOPER_TOKEN = token
  tokenSetAt = Date.now()
  return NextResponse.json({ ok: true, expiresAt: tokenSetAt + 3600000 })
}

export function getTokenExpiry() { return tokenSetAt ? tokenSetAt + 3600000 : null }

/** POST /api/pipeline — trigger a new scrape */
export async function POST(request: Request) {
  const body = await request.json().catch(() => ({}))
  const query = (body as Record<string, string>).query || "Seattle news today"

  try {
    const { runId } = await startScrape(query)
    currentRun = { runId, startedAt: new Date().toISOString(), query }
    return NextResponse.json({ status: "started", runId })
  } catch (e) {
    return NextResponse.json({ error: String(e) }, { status: 500 })
  }
}

/** GET /api/pipeline — get current state, box files, or history */
export async function GET(request: Request) {
  const { searchParams } = new URL(request.url)
  const action = searchParams.get("action")

  if (action === "history") {
    const { data } = await supabase
      .from("world_events")
      .select("*")
      .order("created_at", { ascending: false })
      .limit(20)
    return NextResponse.json({ events: data || [] })
  }

  if (action === "token_status") {
    const expiresAt = tokenSetAt ? tokenSetAt + 3600000 : null
    return NextResponse.json({ expiresAt })
  }

  // Poll scrape status
  if (!currentRun) {
    return NextResponse.json({ status: "idle", lastResults })
  }

  try {
    const { status, items } = await getScrapeResults(currentRun.runId)
    if (status === "SUCCEEDED") {
      lastResults = { items }
      const finished = { status: "completed", run: currentRun, results: lastResults }
      currentRun = null
      return NextResponse.json(finished)
    }
    return NextResponse.json({ status: "running", run: currentRun })
  } catch (e) {
    return NextResponse.json({ status: "error", error: String(e) })
  }
}

/** PUT /api/pipeline — store in Box + summarize + persist */
export async function PUT(request: Request) {
  const body = await request.json().catch(() => ({}))
  const { items, query } = body as { items?: unknown[]; query?: string }

  if (!items?.length && !lastResults?.items?.length) {
    return NextResponse.json({ error: "No items to process" }, { status: 400 })
  }

  const data = items || lastResults?.items || []
  const filename = `scrape-${new Date().toISOString().slice(0, 10)}.json`

  try {
    const { fileId } = await uploadJsonToBox(filename, data)

    // Box needs a moment to process the file before AI can read it
    await new Promise(resolve => setTimeout(resolve, 3000))

    const summary = await askBoxAI(
      fileId,
      "You are a factual news summarizer. Summarize the key events and disruptions in Seattle from this data in 2-3 concise sentences. Focus on things that would affect people's daily routines (weather, road closures, transit issues, major events). Do NOT ask follow-up questions or offer to do more research. Just state the facts."
    )

    // Persist to Supabase
    const headlines = (data as Record<string, unknown>[]).map(d => d.title).filter(Boolean)
    await supabase.from("world_events").insert({
      summary,
      source: "pipeline",
      scrape_query: query || "Seattle news today",
      box_file_id: fileId,
      headlines,
    })

    return NextResponse.json({ fileId, summary })
  } catch (e) {
    return NextResponse.json({ error: String(e) }, { status: 500 })
  }
}

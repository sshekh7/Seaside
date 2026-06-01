import { NextResponse } from "next/server"
import { readFile } from "node:fs/promises"
import { join } from "node:path"
import { readdir } from "node:fs/promises"

const PLANS_DIR = join(process.cwd(), "experiments", "output", "plans")

export async function GET(request: Request) {
  const { searchParams } = new URL(request.url)
  const agentName = searchParams.get("agent")
  const simDate = searchParams.get("date")
  if (!agentName || !simDate) {
    return NextResponse.json({ error: "agent and date required" }, { status: 400 })
  }

  const slug = agentName.toLowerCase().replace(/\s+/g, "-")
  const filename = `${simDate}-${slug}.json`
  try {
    const raw = await readFile(join(PLANS_DIR, filename), "utf8")
    return NextResponse.json(JSON.parse(raw), {
      headers: { "Cache-Control": "public, max-age=86400" },
    })
  } catch {
    // Fallback: search by agent name prefix
    const entries = await readdir(PLANS_DIR)
    const match = entries.find(f => f.startsWith(simDate) && f.includes(slug))
    if (match) {
      const raw = await readFile(join(PLANS_DIR, match), "utf8")
      return NextResponse.json(JSON.parse(raw), {
        headers: { "Cache-Control": "public, max-age=86400" },
      })
    }
    return NextResponse.json({ error: "not found" }, { status: 404 })
  }
}

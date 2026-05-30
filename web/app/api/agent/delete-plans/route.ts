import { NextRequest, NextResponse } from "next/server"
import { readdir, unlink } from "node:fs/promises"
import { join } from "node:path"

const PLANS_DIR = join(process.cwd(), "experiments", "output", "plans")

export async function POST(req: NextRequest) {
  const { agent_name } = await req.json()
  if (!agent_name) return NextResponse.json({ error: "agent_name required" }, { status: 400 })

  const slug = agent_name.toLowerCase().replace(/\s+/g, "-")
  try {
    const files = await readdir(PLANS_DIR)
    const toDelete = files.filter((f) => f.includes(slug) && f.endsWith(".json"))
    await Promise.all(toDelete.map((f) => unlink(join(PLANS_DIR, f))))
    return NextResponse.json({ deleted: toDelete.length })
  } catch {
    return NextResponse.json({ deleted: 0 })
  }
}

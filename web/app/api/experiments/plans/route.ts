import { NextResponse } from "next/server"
import { readdir, readFile } from "node:fs/promises"
import { join } from "node:path"

const PLANS_DIR = join(process.cwd(), "experiments", "output", "plans")

export const dynamic = "force-dynamic"

export async function GET() {
  let entries: string[]
  try {
    entries = await readdir(PLANS_DIR)
  } catch {
    return NextResponse.json({ plans: [] })
  }
  const files = entries.filter((f) => f.endsWith(".json")).sort()
  const plans = await Promise.all(
    files.map(async (file) => {
      try {
        const raw = await readFile(join(PLANS_DIR, file), "utf8")
        const data = JSON.parse(raw)
        return { file, data }
      } catch {
        return null
      }
    }),
  )
  return NextResponse.json({ plans: plans.filter(Boolean) })
}

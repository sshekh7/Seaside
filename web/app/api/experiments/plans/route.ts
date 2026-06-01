import { NextResponse } from "next/server"
import { readFile } from "node:fs/promises"
import { join } from "node:path"

const BUNDLE = join(process.cwd(), "experiments", "output", "plans-bundle.json")

let cached: string | null = null

export async function GET() {
  if (!cached) {
    try {
      cached = await readFile(BUNDLE, "utf8")
    } catch {
      return NextResponse.json({ plans: [] })
    }
  }
  return new NextResponse(cached, {
    headers: {
      "Content-Type": "application/json",
      "Cache-Control": "public, max-age=3600",
    },
  })
}

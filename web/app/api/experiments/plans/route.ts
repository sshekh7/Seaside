import { NextResponse } from "next/server"
import { readFile } from "node:fs/promises"
import { join } from "node:path"
import { existsSync } from "node:fs"

export const dynamic = "force-dynamic"

export async function GET() {
  // Try multiple possible locations for the bundle
  const candidates = [
    join(process.cwd(), "experiments", "output", "plans-bundle.json"),
    join(process.cwd(), "web", "experiments", "output", "plans-bundle.json"),
  ]

  for (const path of candidates) {
    if (existsSync(path)) {
      const data = await readFile(path, "utf8")
      return new NextResponse(data, {
        headers: {
          "Content-Type": "application/json",
          "Cache-Control": "public, max-age=3600",
        },
      })
    }
  }

  return NextResponse.json([])
}

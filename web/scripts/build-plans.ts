/**
 * Consolidates 1386 individual plan JSON files into a single optimized bundle.
 * Strips fields not needed for map rendering (diary, thought_process, stats, reasoning).
 * Reduces polyline precision to 5 decimal places (~1m accuracy).
 *
 * Usage: bun run scripts/build-plans.ts
 * Output: experiments/output/plans-bundle.json
 */

import { readdir, readFile, writeFile } from "node:fs/promises"
import { join, dirname } from "node:path"
import { fileURLToPath } from "node:url"

const __dirname = dirname(fileURLToPath(import.meta.url))
const PLANS_DIR = join(__dirname, "..", "experiments", "output", "plans")
const OUT_FILE = join(__dirname, "..", "experiments", "output", "plans-bundle.json")

type LngLat = [number, number]

function roundCoord(c: LngLat): LngLat {
  return [Math.round(c[0] * 1e5) / 1e5, Math.round(c[1] * 1e5) / 1e5]
}

function simplifyPolyline(poly: LngLat[], tolerance = 0.0001): LngLat[] {
  if (poly.length <= 2) return poly.map(roundCoord)
  // Douglas-Peucker simplification
  let maxDist = 0, maxIdx = 0
  const start = poly[0], end = poly[poly.length - 1]
  for (let i = 1; i < poly.length - 1; i++) {
    const d = pointLineDistance(poly[i], start, end)
    if (d > maxDist) { maxDist = d; maxIdx = i }
  }
  if (maxDist > tolerance) {
    const left = simplifyPolyline(poly.slice(0, maxIdx + 1), tolerance)
    const right = simplifyPolyline(poly.slice(maxIdx), tolerance)
    return [...left.slice(0, -1), ...right]
  }
  return [roundCoord(start), roundCoord(end)]
}

function pointLineDistance(p: LngLat, a: LngLat, b: LngLat): number {
  const dx = b[0] - a[0], dy = b[1] - a[1]
  const len2 = dx * dx + dy * dy
  if (len2 === 0) return Math.hypot(p[0] - a[0], p[1] - a[1])
  const t = Math.max(0, Math.min(1, ((p[0] - a[0]) * dx + (p[1] - a[1]) * dy) / len2))
  return Math.hypot(p[0] - (a[0] + t * dx), p[1] - (a[1] + t * dy))
}

async function main() {
  const entries = (await readdir(PLANS_DIR)).filter(f => f.endsWith(".json")).sort()
  console.log(`Processing ${entries.length} plan files...`)

  const plans: unknown[] = []
  let originalBytes = 0

  for (const file of entries) {
    const raw = await readFile(join(PLANS_DIR, file), "utf8")
    originalBytes += raw.length
    const d = JSON.parse(raw)
    if (!d.beats?.length) continue

    plans.push({
      sim_date: d.sim_date,
      day_number: d.day_number,
      agent_id: d.agent_id,
      agent_name: d.agent_name,
      world_event_prompt: d.world_event_prompt,
      beats: d.beats.map((b: Record<string, unknown>) => ({
        index: b.index,
        start_time: b.start_time,
        end_time: b.end_time,
        activity: b.activity,
        activity_type: b.activity_type,
        location_name: b.location_name,
        location: roundCoord(b.location as LngLat),
        travel_from_prev: b.travel_from_prev ? {
          mode: (b.travel_from_prev as Record<string, unknown>).mode,
          duration_minutes: (b.travel_from_prev as Record<string, unknown>).duration_minutes,
          polyline: simplifyPolyline(
            (b.travel_from_prev as Record<string, unknown>).polyline as LngLat[],
          ),
        } : null,
      })),
    })
  }

  const output = JSON.stringify(plans)
  await writeFile(OUT_FILE, output)

  const savings = ((1 - output.length / originalBytes) * 100).toFixed(1)
  console.log(`Done. ${entries.length} plans → 1 file`)
  console.log(`Original: ${(originalBytes / 1e6).toFixed(1)} MB`)
  console.log(`Bundle:   ${(output.length / 1e6).toFixed(1)} MB (${savings}% smaller)`)
}

main().catch(console.error)

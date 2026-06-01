/**
 * Splits the plans bundle into per-day files for lazy loading.
 * Also generates a manifest with day metadata.
 *
 * Output:
 *   public/plans/manifest.json
 *   public/plans/2026-06-01.json
 *   public/plans/2026-06-02.json
 *   ...
 */

import { readFile, writeFile, mkdir } from "node:fs/promises"
import { join, dirname } from "node:path"
import { fileURLToPath } from "node:url"

const __dirname = dirname(fileURLToPath(import.meta.url))
const BUNDLE = join(__dirname, "..", "public", "plans-bundle.json")
const OUT_DIR = join(__dirname, "..", "public", "plans")

async function main() {
  const raw = await readFile(BUNDLE, "utf8")
  const plans = JSON.parse(raw)

  // Group by day
  const byDay: Record<string, unknown[]> = {}
  for (const p of plans) {
    const key = p.sim_date
    if (!byDay[key]) byDay[key] = []
    byDay[key].push(p)
  }

  await mkdir(OUT_DIR, { recursive: true })

  const manifest: { sim_date: string; day_number: number; agent_count: number; file: string }[] = []

  for (const [date, dayPlans] of Object.entries(byDay)) {
    const filename = `${date}.json`
    await writeFile(join(OUT_DIR, filename), JSON.stringify(dayPlans))
    manifest.push({
      sim_date: date,
      day_number: (dayPlans[0] as Record<string, unknown>).day_number as number,
      agent_count: dayPlans.length,
      file: `/plans/${filename}`,
    })
  }

  manifest.sort((a, b) => a.day_number - b.day_number)
  await writeFile(join(OUT_DIR, "manifest.json"), JSON.stringify(manifest, null, 2))

  console.log(`Split into ${manifest.length} day files:`)
  for (const m of manifest) {
    const size = JSON.stringify(byDay[m.sim_date]).length
    console.log(`  ${m.sim_date}: ${m.agent_count} agents, ${(size / 1024).toFixed(0)}KB`)
  }
}

main().catch(console.error)

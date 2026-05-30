// Seed N diverse synthetic agents into Supabase (anon insert, same path the
// /agents/new page uses). Personas are generated locally from curated pools of
// Seattle-area names, neighborhoods, jobs, and personality traits — no LLM
// needed, so it's fast and deterministic-ish (seedable via SEED env).
//
// Usage:
//   bun run experiments/05-seed-agents.ts            # inserts 100 agents
//   COUNT=50 bun run experiments/05-seed-agents.ts   # custom count
//   DRY_RUN=1 bun run experiments/05-seed-agents.ts  # print, don't insert

import "dotenv/config"
import { mkdirSync, writeFileSync } from "node:fs"
import { createClient } from "@supabase/supabase-js"
import { genConfig } from "react-nice-avatar"

const url = process.env.NEXT_PUBLIC_SUPABASE_URL!
const key = process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY!
if (!url || !key) throw new Error("Supabase env vars missing")
const client = createClient(url, key)

const COUNT = parseInt(process.env.COUNT || "100", 10)
const DRY_RUN = process.env.DRY_RUN === "1"
// Where to record the inserted IDs. Use a distinct file per batch so a running
// planner (which reads its own IDs file) is never disturbed.
const OUT = process.env.OUT || "seeded-agents.json"

// Small seedable PRNG so re-runs with the same SEED produce the same people.
let _seed = parseInt(process.env.SEED || "424242", 10)
function rnd() {
  _seed = (_seed * 1664525 + 1013904223) % 4294967296
  return _seed / 4294967296
}
function pick<T>(arr: T[]): T {
  return arr[Math.floor(rnd() * arr.length)]
}
function pickN<T>(arr: T[], n: number): T[] {
  const pool = [...arr]
  const out: T[] = []
  for (let i = 0; i < n && pool.length; i++) {
    out.push(pool.splice(Math.floor(rnd() * pool.length), 1)[0])
  }
  return out
}
function int(min: number, max: number) {
  return Math.floor(rnd() * (max - min + 1)) + min
}

const FIRST = [
  "Aiden", "Sofia", "Liam", "Emma", "Noah", "Olivia", "Ethan", "Ava", "Mason", "Isabella",
  "Lucas", "Mia", "Logan", "Amelia", "Jackson", "Harper", "Daniel", "Evelyn", "Henry", "Abigail",
  "Sebastian", "Grace", "Jack", "Chloe", "Owen", "Zoe", "Wyatt", "Lily", "Caleb", "Nora",
  "Nathan", "Hazel", "Isaac", "Aria", "Ryan", "Ellie", "Hassan", "Layla", "Diego", "Camila",
  "Kenji", "Yuki", "Wei", "Mei", "Arjun", "Priya", "Omar", "Fatima", "Andre", "Nia",
  "Tomas", "Elena", "Viktor", "Anya", "Mateo", "Lucia", "Kwame", "Amara", "Sven", "Ingrid",
  "Raj", "Divya", "Hiro", "Sakura", "Pavel", "Olga", "Cyrus", "Leila", "Marcus", "Tessa",
  "Felix", "Dahlia", "Quinn", "Sage", "River", "Wren", "Asa", "Juniper", "Eli", "Maren",
]
const LAST = [
  "Nguyen", "Kim", "Patel", "Garcia", "Chen", "Johnson", "Martinez", "Lee", "Brooks", "Webb",
  "Torres", "Park", "Rivera", "Hughes", "Foster", "Bennett", "Coleman", "Reyes", "Sullivan", "Russo",
  "Okafor", "Petrov", "Schmidt", "Andersen", "Tanaka", "Sharma", "Hassan", "Murphy", "Delgado", "Vance",
  "Holloway", "Castillo", "Iqbal", "Romano", "Larsen", "Fischer", "Mensah", "Novak", "Sato", "Kapoor",
  "Whitfield", "Acosta", "Donovan", "Beckett", "Marsh", "Calloway", "Esparza", "Lindqvist", "Yamamoto", "Bauer",
]
// Home locations are generated as STREET ADDRESSES (see makeHome) rather than
// neighborhood names. Neighborhood names like "Capitol Hill" / "Fremont" are
// curated landmarks in lib/mapbox.ts and all snap to one fixed coordinate, so
// using them makes every resident share an identical home point. Street
// addresses hit the real Mapbox geocoder and spread out across the city.
//
// Each entry: real streets with a plausible house-number range and the
// directional/city suffix Mapbox expects. Numbers are randomized per agent.
// Streets are split by region so a batch can be scoped to the Eastside (or
// Seattle) via the REGION env var: "seattle" | "eastside" | "all" (default).
type Street = { street: string; suffix: string; min: number; max: number }

const SEATTLE_STREETS: Street[] = [
  // North Seattle
  { street: "NE 65th St", suffix: "Seattle, WA", min: 100, max: 4500 },
  { street: "NE 45th St", suffix: "Seattle, WA", min: 1000, max: 5200 },
  { street: "N 85th St", suffix: "Seattle, WA", min: 100, max: 3800 },
  { street: "Greenwood Ave N", suffix: "Seattle, WA", min: 6500, max: 14000 },
  { street: "Aurora Ave N", suffix: "Seattle, WA", min: 4500, max: 13000 },
  { street: "15th Ave NE", suffix: "Seattle, WA", min: 4000, max: 8500 },
  { street: "Roosevelt Way NE", suffix: "Seattle, WA", min: 4200, max: 9200 },
  { street: "Sand Point Way NE", suffix: "Seattle, WA", min: 5000, max: 9000 },
  { street: "35th Ave NE", suffix: "Seattle, WA", min: 5500, max: 9500 },
  // Central / east Seattle
  { street: "E Madison St", suffix: "Seattle, WA", min: 1500, max: 4200 },
  { street: "15th Ave E", suffix: "Seattle, WA", min: 300, max: 2600 },
  { street: "23rd Ave E", suffix: "Seattle, WA", min: 200, max: 2400 },
  { street: "E Cherry St", suffix: "Seattle, WA", min: 1000, max: 3400 },
  { street: "Rainier Ave S", suffix: "Seattle, WA", min: 2500, max: 9500 },
  { street: "MLK Jr Way S", suffix: "Seattle, WA", min: 2000, max: 8800 },
  { street: "Beacon Ave S", suffix: "Seattle, WA", min: 2400, max: 6400 },
  // West / SW Seattle
  { street: "California Ave SW", suffix: "Seattle, WA", min: 3500, max: 9500 },
  { street: "35th Ave SW", suffix: "Seattle, WA", min: 4000, max: 9000 },
  { street: "Delridge Way SW", suffix: "Seattle, WA", min: 3000, max: 9000 },
  { street: "SW Admiral Way", suffix: "Seattle, WA", min: 1500, max: 4500 },
  // NW Seattle
  { street: "24th Ave NW", suffix: "Seattle, WA", min: 5000, max: 9000 },
  { street: "32nd Ave NW", suffix: "Seattle, WA", min: 6500, max: 8800 },
  { street: "15th Ave NW", suffix: "Seattle, WA", min: 4500, max: 9500 },
]

const EASTSIDE_STREETS: Street[] = [
  // Bellevue
  { street: "148th Ave NE", suffix: "Bellevue, WA", min: 1000, max: 7000 },
  { street: "Bel-Red Rd", suffix: "Bellevue, WA", min: 12000, max: 16000 },
  { street: "Northup Way", suffix: "Bellevue, WA", min: 10000, max: 14000 },
  { street: "Lake Hills Blvd", suffix: "Bellevue, WA", min: 14000, max: 16800 },
  { street: "108th Ave NE", suffix: "Bellevue, WA", min: 100, max: 4200 },
  { street: "Newport Way", suffix: "Bellevue, WA", min: 12000, max: 16500 },
  { street: "Somerset Blvd SE", suffix: "Bellevue, WA", min: 4000, max: 6200 },
  // Redmond
  { street: "156th Ave NE", suffix: "Redmond, WA", min: 7000, max: 11000 },
  { street: "Avondale Rd NE", suffix: "Redmond, WA", min: 8000, max: 13000 },
  { street: "Redmond Way", suffix: "Redmond, WA", min: 15000, max: 18500 },
  { street: "NE 116th St", suffix: "Redmond, WA", min: 7000, max: 11000 },
  { street: "Education Hill Rd NE", suffix: "Redmond, WA", min: 8000, max: 10500 },
  // Kirkland
  { street: "6th St S", suffix: "Kirkland, WA", min: 100, max: 1500 },
  { street: "NE 85th St", suffix: "Kirkland, WA", min: 200, max: 1400 },
  { street: "Market St", suffix: "Kirkland, WA", min: 100, max: 1800 },
  { street: "Juanita Dr NE", suffix: "Kirkland, WA", min: 9000, max: 13500 },
  { street: "100th Ave NE", suffix: "Kirkland, WA", min: 7000, max: 12000 },
  // Renton
  { street: "Benson Rd S", suffix: "Renton, WA", min: 2000, max: 4200 },
  { street: "NE 4th St", suffix: "Renton, WA", min: 1000, max: 4600 },
  { street: "Union Ave NE", suffix: "Renton, WA", min: 1000, max: 4400 },
  // Issaquah / Sammamish
  { street: "NW Sammamish Rd", suffix: "Issaquah, WA", min: 100, max: 2600 },
  { street: "Front St N", suffix: "Issaquah, WA", min: 100, max: 1900 },
  { street: "228th Ave SE", suffix: "Sammamish, WA", min: 1000, max: 4200 },
  { street: "SE 8th St", suffix: "Sammamish, WA", min: 20000, max: 24000 },
  // Bothell / Woodinville
  { street: "Main St", suffix: "Bothell, WA", min: 9000, max: 12000 },
  { street: "NE 195th St", suffix: "Bothell, WA", min: 1000, max: 4200 },
  { street: "NE 175th St", suffix: "Woodinville, WA", min: 13000, max: 17000 },
  { street: "Woodinville-Redmond Rd NE", suffix: "Woodinville, WA", min: 13000, max: 17000 },
  // Mercer Island / Newcastle
  { street: "Island Crest Way", suffix: "Mercer Island, WA", min: 2000, max: 8000 },
  { street: "Coal Creek Pkwy SE", suffix: "Newcastle, WA", min: 6000, max: 9000 },
  // Shoreline (north end, between Seattle & Eastside)
  { street: "Aurora Ave N", suffix: "Shoreline, WA", min: 14500, max: 20000 },
]

const REGION = (process.env.REGION || "all").toLowerCase()
const STREETS: Street[] =
  REGION === "eastside" ? EASTSIDE_STREETS : REGION === "seattle" ? SEATTLE_STREETS : [...SEATTLE_STREETS, ...EASTSIDE_STREETS]

function makeHome(): string {
  const s = pick(STREETS)
  return `${int(s.min, s.max)} ${s.street}, ${s.suffix}`
}
const SEATTLE_HUBS = [
  "South Lake Union, Seattle", "Downtown Seattle", "Pioneer Square, Seattle",
  "Fremont, Seattle", "Ballard, Seattle", "U-District, Seattle",
  "Interbay, Seattle", "SoDo, Seattle", "First Hill, Seattle", "Capitol Hill, Seattle",
  "Georgetown, Seattle",
]
const EASTSIDE_HUBS = [
  "Bellevue downtown", "Redmond, WA", "Kirkland, WA", "Renton, WA",
  "Issaquah, WA", "Bothell, WA", "Factoria, Bellevue", "Overlake, Redmond",
  "Totem Lake, Kirkland", "Sammamish, WA", "Woodinville, WA", "Mercer Island, WA",
]
const WORK_HUBS =
  REGION === "eastside" ? EASTSIDE_HUBS : REGION === "seattle" ? SEATTLE_HUBS : [...SEATTLE_HUBS, ...EASTSIDE_HUBS]
const JOBS = [
  "Software engineer at a cloud infrastructure startup",
  "Barista and shift lead at a third-wave coffee shop",
  "ER nurse at a downtown hospital",
  "High school science teacher",
  "UX designer at a mid-size SaaS company",
  "Line cook at a busy Capitol Hill restaurant",
  "Freelance photographer and part-time bartender",
  "Data analyst at an e-commerce company",
  "Construction project manager",
  "Marine biologist doing fieldwork on Puget Sound",
  "Independent musician who teaches guitar lessons",
  "Pediatric dentist with a small practice",
  "Bus driver for King County Metro",
  "Graduate student in computer science",
  "Yoga instructor and wellness coach",
  "Civil engineer at a transit agency",
  "Bookstore owner in a quiet neighborhood",
  "Product manager at a fintech startup",
  "Veterinary technician at an animal clinic",
  "Bike mechanic and weekend cycling guide",
  "Accountant during tax season, hiker otherwise",
  "Social worker for a youth nonprofit",
  "Brewer at a craft brewery",
  "Real estate agent specializing in condos",
  "Librarian at a branch of Seattle Public Library",
  "Tattoo artist with a Fremont studio",
  "Climate researcher at the university",
  "Pastry chef at a French bakery",
  "Firefighter on a 24-hour rotation",
  "Game developer at an indie studio",
  "Pharmacist at a neighborhood drugstore",
  "Landscape architect for city parks",
  "Stand-up comedian who waits tables by day",
  "Physical therapist at a sports clinic",
  "Florist running a small Pike Place stall",
  "Air traffic controller at Sea-Tac",
  "Nonprofit grant writer working from home",
  "Welder at a shipyard in Interbay",
  "Elementary school counselor",
  "Cybersecurity consultant who travels often",
  "Emergency dispatcher for the fire department",
  "Wedding and event planner",
  "Auto mechanic at an independent garage",
  "Commercial fisherman based out of Fishermen's Terminal",
  "Radiologic technologist at a clinic",
  "Sommelier at a downtown steakhouse",
  "Machine learning researcher at a robotics lab",
  "Hospice nurse doing home visits",
  "Carpenter and custom furniture maker",
  "Museum curator at an art institution",
  "Translator and court interpreter",
  "Sound engineer for a recording studio",
  "Public defender at the county courthouse",
  "Dog walker and pet sitter running a small business",
  "Optometrist with a neighborhood practice",
  "Warehouse logistics coordinator",
  "Speech therapist working with kids",
  "Barber at a classic shop",
  "Wind turbine technician who commutes to job sites",
  "Insurance claims adjuster",
  "Chef de partie at a fine-dining restaurant",
  "Ceramicist selling at craft fairs",
  "Transit planner for Sound Transit",
  "Midwife at a birth center",
  "Solar panel installer",
  "Archivist at the university library",
  "Esports coach for a competitive team",
  "Beekeeper and urban farmer",
]
const TRAITS = [
  "early riser", "night owl", "deeply introverted", "gregarious and chatty", "fiercely organized",
  "spontaneous to a fault", "anxious but high-achieving", "laid-back and unbothered", "intensely curious",
  "stubbornly routine-bound", "adventurous eater", "creature of habit", "competitive", "nurturing",
  "frugal", "generous with money", "obsessed with fitness", "homebody", "social butterfly", "workaholic",
  "easily distracted", "hyper-focused", "skeptical", "optimistic", "nostalgic", "future-oriented",
  "meticulous planner", "go-with-the-flow", "deeply empathetic", "blunt and direct", "conflict-averse",
  "thrill-seeking", "risk-averse", "sentimental", "pragmatic", "idealistic", "sarcastic",
  "endlessly patient", "quick-tempered", "self-reliant", "community-minded", "perfectionist", "easygoing",
]
const HOBBIES = [
  "rock climbing", "kayaking on Lake Union", "trail running", "vinyl collecting", "sourdough baking",
  "birdwatching", "board game nights", "open-mic poetry", "thrifting", "urban gardening",
  "weekend camping", "film photography", "salsa dancing", "pottery", "long-distance cycling",
  "video gaming", "volunteering at the food bank", "fly fishing", "painting", "home brewing",
  "pickup basketball", "knitting", "chess", "foraging for mushrooms", "stargazing",
]
const QUIRKS = [
  "refuses to drink drip coffee", "names every houseplant", "keeps a meticulous spreadsheet of expenses",
  "always takes the scenic route", "can't start the day without a swim", "talks to their dog like a coworker",
  "collects transit maps from every city visited", "has strong opinions about bagels",
  "carries a film camera everywhere", "tracks the ferry schedule obsessively",
  "writes letters by hand", "knows every food truck's rotation", "can't resist a bookstore",
  "tends a rooftop herb garden", "runs on espresso and stubbornness",
]

function buildPersonality(opts: { traits: string[]; hobbies: string[]; quirk: string; job: string }): string {
  const [t1, t2] = opts.traits
  const [h1, h2] = opts.hobbies
  return (
    `A ${t1}, ${t2} Seattleite. Works as a ${opts.job.toLowerCase()}. ` +
    `Spends free time on ${h1} and ${h2}. ${capitalize(opts.quirk)}. ` +
    `Tends to plan days around weather and mood, and values time with close friends over big crowds.`
  )
}
function capitalize(s: string) {
  return s.charAt(0).toUpperCase() + s.slice(1)
}

type NewAgent = {
  name: string
  profile_pic: unknown
  job_description: string
  location_work: string
  location_home: string
  age: number
  personality: string
}

function generate(count: number): NewAgent[] {
  const used = new Set<string>()
  const out: NewAgent[] = []
  let guard = 0
  while (out.length < count && guard < count * 50) {
    guard++
    const name = `${pick(FIRST)} ${pick(LAST)}`
    if (used.has(name)) continue
    used.add(name)
    const job = pick(JOBS)
    const traits = pickN(TRAITS, 2)
    const hobbies = pickN(HOBBIES, 2)
    const quirk = pick(QUIRKS)
    out.push({
      name,
      profile_pic: genConfig(),
      job_description: job,
      location_work: pick(WORK_HUBS),
      location_home: makeHome(),
      age: int(22, 64),
      personality: buildPersonality({ traits, hobbies, quirk, job }),
    })
  }
  return out
}

async function main() {
  const agents = generate(COUNT)
  console.log(`[seed] generated ${agents.length} agents (SEED=${process.env.SEED || "424242"})`)
  console.log(`[seed] sample:`)
  for (const a of agents.slice(0, 3)) {
    console.log(`  - ${a.name}, ${a.age}, ${a.job_description}`)
    console.log(`    home=${a.location_home} work=${a.location_work}`)
    console.log(`    ${a.personality}`)
  }

  if (DRY_RUN) {
    console.log(`\n[seed] DRY_RUN=1 — not inserting.`)
    return
  }

  // Insert in chunks to stay well under payload limits.
  const CHUNK = 25
  const insertedIds: string[] = []
  for (let i = 0; i < agents.length; i += CHUNK) {
    const batch = agents.slice(i, i + CHUNK)
    const { data, error } = await client.from("agents").insert(batch).select("id")
    if (error) {
      console.error(`[seed] insert failed at chunk ${i / CHUNK}:`, error.message)
      process.exit(1)
    }
    for (const row of data ?? []) insertedIds.push((row as { id: string }).id)
    console.log(`[seed] inserted ${insertedIds.length}/${agents.length}`)
  }

  // Record the new IDs so the planner can target ONLY these agents.
  const outDir = new URL("./output/", import.meta.url).pathname
  mkdirSync(outDir, { recursive: true })
  const outPath = `${outDir}${OUT}`
  writeFileSync(outPath, JSON.stringify({ created_at: new Date().toISOString(), ids: insertedIds }, null, 2))
  console.log(`[seed] done — ${insertedIds.length} agents inserted. IDs -> ${outPath}`)
}

void main()

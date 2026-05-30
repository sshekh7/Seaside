// Mapbox helpers — geocoding (v6 forward, bbox-constrained to Seattle metro)
// + walking/driving directions — with a file-based cache so reruns don't burn
// API quota.

import { getPlace, setPlace, getRoute, setRoute } from "./cache"
import type { TravelMode } from "./types"

const TOKEN = process.env.NEXT_PUBLIC_MAPBOX_TOKEN!
if (!TOKEN) throw new Error("NEXT_PUBLIC_MAPBOX_TOKEN missing")

// Hard bounds for what we'll accept as a geocoded place. Seattle metro,
// generously sized to cover Bellevue / Redmond / Sammamish / Issaquah /
// Renton / Bothell. Anything outside this is treated as a geocode failure.
const METRO_BBOX: [number, number, number, number] = [-122.65, 47.30, -121.80, 47.95]
// Proximity bias for ranking — downtown Seattle.
const METRO_PROXIMITY: [number, number] = [-122.3321, 47.6062]
// Cap on a single Seattle-metro travel leg. Anything over this is bogus
// (likely a bad geocode that slipped past the bbox check) — we fall back.
const MAX_TRAVEL_MIN = 90

function inMetro(loc: [number, number]): boolean {
  return (
    loc[0] >= METRO_BBOX[0] &&
    loc[0] <= METRO_BBOX[2] &&
    loc[1] >= METRO_BBOX[1] &&
    loc[1] <= METRO_BBOX[3]
  )
}

let mapboxMs = 0
export function getMapboxMs() {
  return mapboxMs
}
export function resetMapboxMs() {
  mapboxMs = 0
}

// Hand-curated coords for famous Seattle/Eastside landmarks. We match by
// substring on the LOWERCASE name from the LLM, so any phrasing like
// "Gas Works Park", "Gas Works Park (Wallingford)", "the Gas Works Park
// concert" all resolve to the same canonical coord. Mapbox v6 with our
// bbox is unreliable for these (often returns the wrong "Gas Works" in
// Bellevue, or places landmarks at a category-search centroid).
//
// Substrings are checked in order — first match wins, so put more
// specific names first when they share words.
const LANDMARKS: { match: string; loc: [number, number] }[] = [
  { match: "gas works park", loc: [-122.3344, 47.6457] },
  { match: "pike place market", loc: [-122.3422, 47.6097] },
  { match: "pike place", loc: [-122.3422, 47.6097] },
  { match: "volunteer park", loc: [-122.3146, 47.6298] },
  { match: "kerry park", loc: [-122.3599, 47.6294] },
  { match: "discovery park", loc: [-122.4101, 47.6606] },
  { match: "green lake", loc: [-122.3318, 47.6806] },
  { match: "alki beach", loc: [-122.4117, 47.5762] },
  { match: "seattle center", loc: [-122.3493, 47.6205] },
  { match: "space needle", loc: [-122.3493, 47.6205] },
  { match: "lake union", loc: [-122.3367, 47.6427] },
  { match: "westlake park", loc: [-122.3373, 47.6116] },
  { match: "pioneer square", loc: [-122.3331, 47.6010] },
  { match: "capitol hill", loc: [-122.3192, 47.6213] },
  { match: "fremont", loc: [-122.3503, 47.6510] },
  { match: "ballard", loc: [-122.3837, 47.6685] },
  { match: "wallingford", loc: [-122.3320, 47.6605] },
  { match: "queen anne", loc: [-122.3565, 47.6371] },
  { match: "u district", loc: [-122.3128, 47.6605] },
  { match: "university district", loc: [-122.3128, 47.6605] },
  { match: "university of washington", loc: [-122.3035, 47.6553] },
  { match: "south lake union", loc: [-122.3367, 47.6240] },
  { match: "international district", loc: [-122.3232, 47.5973] },
  { match: "chinatown", loc: [-122.3232, 47.5973] },
  // Eastside
  { match: "microsoft main campus", loc: [-122.1311, 47.6422] },
  { match: "microsoft redmond campus", loc: [-122.1311, 47.6422] },
  { match: "microsoft campus", loc: [-122.1311, 47.6422] },
  { match: "building 99", loc: [-122.1311, 47.6429] },
  { match: "building 92", loc: [-122.1359, 47.6402] },
  { match: "redmond town center", loc: [-122.1190, 47.6745] },
  { match: "downtown redmond", loc: [-122.1215, 47.6740] },
  { match: "marymoor park", loc: [-122.1065, 47.6601] },
  { match: "overlake village", loc: [-122.1455, 47.6411] },
  { match: "bellevue downtown park", loc: [-122.2018, 47.6131] },
  { match: "bellevue square", loc: [-122.2015, 47.6172] },
  { match: "downtown bellevue", loc: [-122.2015, 47.6172] },
  { match: "downtown kirkland", loc: [-122.2090, 47.6815] },
  { match: "kirkland waterfront", loc: [-122.2103, 47.6802] },
]

// Returns the curated coord if the name (case-insensitive) contains one
// of our landmark substrings. Stable, demo-grade override.
function landmarkCoord(name: string): [number, number] | null {
  const lower = name.toLowerCase()
  for (const lm of LANDMARKS) {
    if (lower.includes(lm.match)) return lm.loc
  }
  return null
}

let geocodeMisses = 0
let routeMisses = 0
export function getCacheStats() {
  return { geocode_misses: geocodeMisses, route_misses: routeMisses }
}
export function resetCacheStats() {
  geocodeMisses = 0
  routeMisses = 0
}

export async function geocode(
  name: string,
): Promise<[number, number] | null> {
  // Curated landmarks always win — they bypass the cache so renaming a
  // landmark in the LANDMARKS list takes effect immediately on next run.
  const curated = landmarkCoord(name)
  if (curated) {
    return curated
  }
  const hit = getPlace(name)
  if (hit) {
    if (!inMetro(hit)) return null
    return hit
  }
  geocodeMisses++
  const params = new URLSearchParams({
    q: name,
    limit: "1",
    country: "us",
    bbox: METRO_BBOX.join(","),
    proximity: METRO_PROXIMITY.join(","),
    access_token: TOKEN,
  })
  const url = `https://api.mapbox.com/search/geocode/v6/forward?${params.toString()}`
  const t0 = Date.now()
  const res = await fetch(url)
  mapboxMs += Date.now() - t0
  if (!res.ok) return null
  const data = (await res.json()) as {
    features?: { geometry?: { coordinates?: [number, number] } }[]
  }
  const coords = data.features?.[0]?.geometry?.coordinates
  if (!coords || !inMetro(coords)) return null
  setPlace(name, coords)
  return coords
}

// Decide travel mode from straight-line distance. < 1.5km walk, else drive.
export function pickMode(
  from: [number, number],
  to: [number, number],
): TravelMode {
  const km = haversineKm(from, to)
  return km < 1.5 ? "walking" : "driving"
}

export function haversineKm(
  a: [number, number],
  b: [number, number],
): number {
  const R = 6371
  const toRad = (d: number) => (d * Math.PI) / 180
  const dLat = toRad(b[1] - a[1])
  const dLng = toRad(b[0] - a[0])
  const lat1 = toRad(a[1])
  const lat2 = toRad(b[1])
  const x =
    Math.sin(dLat / 2) ** 2 +
    Math.cos(lat1) * Math.cos(lat2) * Math.sin(dLng / 2) ** 2
  return 2 * R * Math.asin(Math.sqrt(x))
}

export async function directions(
  from: [number, number],
  to: [number, number],
  mode: TravelMode,
): Promise<{ polyline: [number, number][]; duration_minutes: number } | null> {
  const hit = getRoute(from, to, mode)
  if (hit) {
    if (hit.duration_minutes > MAX_TRAVEL_MIN) return null
    return hit
  }
  routeMisses++
  const url = `https://api.mapbox.com/directions/v5/mapbox/${mode}/${from[0]},${from[1]};${to[0]},${to[1]}?geometries=geojson&overview=full&access_token=${TOKEN}`
  const t0 = Date.now()
  const res = await fetch(url)
  mapboxMs += Date.now() - t0
  if (!res.ok) return null
  const data = (await res.json()) as {
    routes?: {
      duration?: number
      geometry?: { coordinates?: [number, number][] }
    }[]
  }
  const route = data.routes?.[0]
  if (!route?.geometry?.coordinates || route.duration == null) return null
  const value = {
    polyline: route.geometry.coordinates,
    duration_minutes: Math.max(1, Math.round(route.duration / 60)),
  }
  if (value.duration_minutes > MAX_TRAVEL_MIN) return null
  setRoute(from, to, mode, value)
  return value
}

// Tiny file-based JSON cache. Two stores: places (name -> [lng,lat]) and
// routes (from|to|mode -> { polyline, duration_minutes }).

import { mkdirSync, readFileSync, writeFileSync, existsSync } from "node:fs"
import { dirname } from "node:path"

const ROOT = new URL("../output/", import.meta.url).pathname
const PLACES = ROOT + "places-cache.json"
const ROUTES = ROOT + "routes-cache.json"

type PlacesCache = Record<string, [number, number]>
type RoutesCache = Record<
  string,
  { polyline: [number, number][]; duration_minutes: number }
>

function loadJson<T>(path: string, fallback: T): T {
  if (!existsSync(path)) return fallback
  try {
    return JSON.parse(readFileSync(path, "utf-8")) as T
  } catch {
    return fallback
  }
}

function saveJson(path: string, value: unknown) {
  mkdirSync(dirname(path), { recursive: true })
  writeFileSync(path, JSON.stringify(value, null, 2))
}

const placesMem: PlacesCache = loadJson(PLACES, {})
const routesMem: RoutesCache = loadJson(ROUTES, {})

export function normalizePlace(name: string): string {
  return name.trim().toLowerCase().replace(/\s+/g, " ")
}

export function placeKey(name: string): string {
  // We no longer append ", seattle wa" — the geocoder is bbox-constrained.
  return normalizePlace(name)
}

export function getPlace(name: string): [number, number] | undefined {
  return placesMem[placeKey(name)]
}

export function setPlace(name: string, loc: [number, number]) {
  placesMem[placeKey(name)] = loc
  saveJson(PLACES, placesMem)
}

function round(n: number, d = 4): number {
  const f = Math.pow(10, d)
  return Math.round(n * f) / f
}

export function routeKey(
  from: [number, number],
  to: [number, number],
  mode: string,
): string {
  return `${round(from[0])},${round(from[1])}|${round(to[0])},${round(to[1])}|${mode}`
}

export function getRoute(
  from: [number, number],
  to: [number, number],
  mode: string,
): { polyline: [number, number][]; duration_minutes: number } | undefined {
  return routesMem[routeKey(from, to, mode)]
}

export function setRoute(
  from: [number, number],
  to: [number, number],
  mode: string,
  value: { polyline: [number, number][]; duration_minutes: number },
) {
  // Store A→B with the canonical polyline.
  routesMem[routeKey(from, to, mode)] = value
  // Store B→A using the reversed polyline. Real-world routes can be slightly
  // asymmetric (one-way streets, turn restrictions) but for a Seattle-scale
  // city sim this approximation looks indistinguishable and halves API hits.
  const reverseKey = routeKey(to, from, mode)
  if (!routesMem[reverseKey]) {
    routesMem[reverseKey] = {
      polyline: [...value.polyline].reverse(),
      duration_minutes: value.duration_minutes,
    }
  }
  saveJson(ROUTES, routesMem)
}

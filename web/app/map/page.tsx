"use client"

import { useEffect, useRef, useState, useCallback } from "react"
import dynamic from "next/dynamic"
import mapboxgl from "mapbox-gl"
import "mapbox-gl/dist/mapbox-gl.css"
import { genConfig } from "react-nice-avatar"
import type { NiceAvatarProps } from "react-nice-avatar"
import {
  ArrowsCounterClockwise,
  CaretDown,
  CaretUp,
  Cube,
  Play,
  WaveSine,
  X,
} from "@phosphor-icons/react/dist/ssr"

import { cn } from "@/lib/utils"
import { supabase } from "@/lib/supabase"

const Avatar = dynamic(() => import("react-nice-avatar"), {
  ssr: false,
  loading: () => (
    <div className="size-full animate-pulse rounded-full bg-muted/40" />
  ),
}) as React.ComponentType<NiceAvatarProps>

const TOKEN = process.env.NEXT_PUBLIC_MAPBOX_TOKEN!

const STYLES = {
  Dark: "mapbox://styles/mapbox/dark-v11",
  Light: "mapbox://styles/mapbox/light-v11",
  Streets: "mapbox://styles/mapbox/streets-v12",
  Satellite: "mapbox://styles/mapbox/satellite-streets-v12",
} as const

type StyleKey = keyof typeof STYLES

const SEATTLE_CENTER: [number, number] = [-122.3321, 47.6062]
const SEATTLE_BOUNDS: [[number, number], [number, number]] = [
  [-122.65, 47.35],
  [-122.05, 47.9],
]

const ZONES: [number, number, number, string][] = [
  [-122.3351, 47.6080, 0.012, "Downtown Seattle"],
  [-122.3380, 47.6250, 0.008, "South Lake Union"],
  [-122.2015, 47.6101, 0.015, "Bellevue"],
  [-122.1215, 47.6740, 0.012, "Redmond"],
  [-122.0355, 47.6165, 0.015, "Sammamish"],
]

const COLORS = ["#ff4444", "#4488ff", "#ff8800", "#44cc88", "#aa44ff", "#ff44aa", "#44dddd", "#ffcc00"]

function randomInZone(zone: [number, number, number, string]): [number, number] {
  const angle = Math.random() * Math.PI * 2
  const r = Math.random() * zone[2]
  return [zone[0] + r * Math.cos(angle), zone[1] + r * Math.sin(angle)]
}

type Agent = {
  id: string
  name: string
  color: string
  personality: string
  config: Record<string, unknown>
  start: [number, number]
  end: [number, number]
  zone: string
  destZone: string
  job_description?: string
  age?: number
  location_home?: string
  location_work?: string
}

async function fetchRoute(start: [number, number], end: [number, number]): Promise<[number, number][] | null> {
  try {
    const res = await fetch(
      `https://api.mapbox.com/directions/v5/mapbox/walking/${start[0]},${start[1]};${end[0]},${end[1]}?geometries=geojson&access_token=${TOKEN}`
    )
    const data = await res.json()
    return data.routes?.[0]?.geometry?.coordinates ?? null
  } catch { return null }
}

function interpolateRoute(coords: [number, number][], stepsPerSegment: number): [number, number][] {
  const result: [number, number][] = []
  for (let i = 0; i < coords.length - 1; i++) {
    const [x1, y1] = coords[i]
    const [x2, y2] = coords[i + 1]
    for (let j = 0; j < stepsPerSegment; j++) {
      const t = j / stepsPerSegment
      result.push([x1 + (x2 - x1) * t, y1 + (y2 - y1) * t])
    }
  }
  result.push(coords[coords.length - 1])
  return result
}

export default function MapPage() {
  const mapContainer = useRef<HTMLDivElement>(null)
  const mapRef = useRef<mapboxgl.Map | null>(null)
  const timersRef = useRef<ReturnType<typeof setTimeout>[]>([])
  const speedRef = useRef(200)
  const [style, setStyle] = useState<StyleKey>("Dark")
  const [is3D, setIs3D] = useState(false)
  const [time, setTime] = useState("--:--:--")
  const [activityOpen, setActivityOpen] = useState(true)
  const [timelineOpen, setTimelineOpen] = useState(false)
  const [agentRunning, setAgentRunning] = useState(false)
  const [speed, setSpeed] = useState(1)
  const [selectedAgent, setSelectedAgent] = useState<Agent | null>(null)
  const [profilePos, setProfilePos] = useState<{ x: number; y: number }>({ x: 0, y: 0 })
  const [agents, setAgents] = useState<Agent[]>([])
  const [loadingRoutes, setLoadingRoutes] = useState(false)
  const agentsRef = useRef<Agent[]>([])

  // Fetch agents from Supabase
  useEffect(() => {
    supabase.from("agents").select("*").then(({ data }) => {
      if (!data || data.length === 0) return
      const mapped: Agent[] = data.map((row, i) => {
        const startZone = ZONES[i % ZONES.length]
        const endZone = ZONES[(i + 1 + Math.floor(i / ZONES.length)) % ZONES.length]
        return {
          id: row.id,
          name: row.name,
          color: COLORS[i % COLORS.length],
          personality: row.personality || "",
          config: row.profile_pic || genConfig(),
          start: randomInZone(startZone),
          end: randomInZone(endZone),
          zone: startZone[3],
          destZone: endZone[3],
          job_description: row.job_description,
          age: row.age,
          location_home: row.location_home,
          location_work: row.location_work,
        }
      })
      setAgents(mapped)
      agentsRef.current = mapped
    })
  }, [])

  useEffect(() => { speedRef.current = 200 / speed }, [speed])

  useEffect(() => {
    const map = new mapboxgl.Map({
      container: mapContainer.current!,
      accessToken: TOKEN,
      style: STYLES[style],
      center: SEATTLE_CENTER,
      zoom: 12,
      minZoom: 9,
      maxZoom: 18,
      maxBounds: SEATTLE_BOUNDS,
      pitch: 0,
      bearing: 0,
      dragRotate: true,
      touchPitch: true,
      touchZoomRotate: true,
      attributionControl: false,
    })
    map.addControl(new mapboxgl.NavigationControl({ visualizePitch: true, showCompass: false }), "bottom-right")
    mapRef.current = map

    map.on("click", "agents-dot", (e) => {
      const idx = e.features?.[0]?.properties?.agentIndex
      if (idx !== undefined) {
        setProfilePos({ x: e.point.x, y: e.point.y })
        setSelectedAgent(agentsRef.current[idx])
      }
    })
    map.on("mouseenter", "agents-dot", () => { map.getCanvas().style.cursor = "pointer" })
    map.on("mouseleave", "agents-dot", () => { map.getCanvas().style.cursor = "" })

    return () => {
      timersRef.current.forEach(clearTimeout)
      map.remove()
    }
  }, [style])

  useEffect(() => {
    const tick = () => {
      const d = new Date()
      const pad = (n: number) => n.toString().padStart(2, "0")
      setTime(`${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}`)
    }
    tick()
    const id = setInterval(tick, 1000)
    return () => clearInterval(id)
  }, [])

  const startAgents = useCallback(async () => {
    const map = mapRef.current
    const currentAgents = agentsRef.current
    if (!map || currentAgents.length === 0) return

    setAgentRunning(true)
    setSelectedAgent(null)
    setLoadingRoutes(true)
    timersRef.current.forEach(clearTimeout)
    timersRef.current = []

    // Fetch routes in batches
    const routes: ([number, number][] | null)[] = []
    for (let batch = 0; batch < currentAgents.length; batch += 10) {
      const batchResults = await Promise.all(
        currentAgents.slice(batch, batch + 10).map((a) => fetchRoute(a.start, a.end))
      )
      routes.push(...batchResults)
    }
    setLoadingRoutes(false)

    const smoothRoutes: [number, number][][] = []
    const routeFeatures: GeoJSON.Feature[] = []

    routes.forEach((route, i) => {
      if (!route) { smoothRoutes.push([]); return }
      smoothRoutes.push(interpolateRoute(route, 3))
      routeFeatures.push({
        type: "Feature",
        properties: { color: currentAgents[i].color },
        geometry: { type: "LineString", coordinates: route },
      })
    })

    const routeCollection: GeoJSON.FeatureCollection = { type: "FeatureCollection", features: routeFeatures }
    if (map.getSource("all-routes")) {
      (map.getSource("all-routes") as mapboxgl.GeoJSONSource).setData(routeCollection)
    } else {
      map.addSource("all-routes", { type: "geojson", data: routeCollection })
      map.addLayer({
        id: "all-routes-line", type: "line", source: "all-routes",
        paint: { "line-color": ["get", "color"], "line-width": 1.5, "line-opacity": 0.3 },
      })
    }

    const makeCollection = (positions: [number, number][]): GeoJSON.FeatureCollection => ({
      type: "FeatureCollection",
      features: positions.map((pos, i) => ({
        type: "Feature" as const,
        properties: { agentIndex: i, color: currentAgents[i].color },
        geometry: { type: "Point" as const, coordinates: pos },
      })),
    })

    const currentPositions = currentAgents.map((a, i) => smoothRoutes[i]?.[0] ?? a.start)

    if (map.getSource("agents-src")) {
      (map.getSource("agents-src") as mapboxgl.GeoJSONSource).setData(makeCollection(currentPositions))
    } else {
      map.addSource("agents-src", { type: "geojson", data: makeCollection(currentPositions) })
      map.addLayer({
        id: "agents-glow", type: "circle", source: "agents-src",
        paint: { "circle-radius": 10, "circle-color": ["get", "color"], "circle-opacity": 0.2, "circle-blur": 1 },
      })
      map.addLayer({
        id: "agents-dot", type: "circle", source: "agents-src",
        paint: { "circle-radius": 5, "circle-color": ["get", "color"], "circle-stroke-width": 1.5, "circle-stroke-color": "#fff" },
      })
    }

    const indices = new Array(currentAgents.length).fill(0)
    let done = false

    const step = () => {
      if (done) return
      let allDone = true
      for (let i = 0; i < currentAgents.length; i++) {
        if (indices[i] < smoothRoutes[i].length) {
          currentPositions[i] = smoothRoutes[i][indices[i]]
          indices[i]++
          allDone = false
        }
      }
      (map.getSource("agents-src") as mapboxgl.GeoJSONSource).setData(makeCollection(currentPositions))
      if (allDone) { setAgentRunning(false); done = true; return }
      const t = setTimeout(step, speedRef.current)
      timersRef.current.push(t)
    }
    step()
  }, [])

  const toggle3D = () => {
    const map = mapRef.current
    if (!map) return
    if (is3D) {
      map.easeTo({ pitch: 0, bearing: 0 })
      if (map.getLayer("3d-buildings")) map.removeLayer("3d-buildings")
    } else {
      map.easeTo({ pitch: 55, bearing: 0 })
      map.once("idle", () => {
        if (!map.getLayer("3d-buildings")) {
          if (!map.getSource("composite")) {
            map.addSource("composite", { type: "vector", url: "mapbox://mapbox.mapbox-streets-v8" })
          }
          map.addLayer({
            id: "3d-buildings", source: "composite", "source-layer": "building",
            type: "fill-extrusion", minzoom: 14,
            paint: {
              "fill-extrusion-color": "#aaa",
              "fill-extrusion-height": ["get", "height"],
              "fill-extrusion-base": ["get", "min_height"],
              "fill-extrusion-opacity": 0.6,
            },
          })
        }
      })
    }
    setIs3D(!is3D)
  }

  const resetView = () => {
    mapRef.current?.flyTo({ center: SEATTLE_CENTER, zoom: 12, pitch: 0, bearing: 0 })
    setIs3D(false)
  }

  return (
    <div className="flex h-svh w-full flex-1 flex-col overflow-hidden bg-background text-foreground">
      <div className="relative min-h-0 flex-1">
        <div ref={mapContainer} className="absolute inset-0 h-full w-full" />

        {/* Top-left: clock */}
        <div className="absolute left-4 top-4 z-20 flex items-center gap-3">
          <div className="flex items-center gap-2 rounded-md border border-border/60 bg-card/80 px-3 py-1.5 backdrop-blur">
            <span className="size-1.5 rounded-full bg-emerald-400 shadow-[0_0_6px_0_var(--color-emerald-400,#34d399)]" />
            <span className="font-mono text-xs tracking-[0.18em] text-foreground tabular-nums">{time}</span>
          </div>
          <span className="hidden text-[10px] uppercase tracking-[0.2em] text-muted-foreground sm:inline">
            {agents.length} Agents · {ZONES.length} Zones
          </span>
        </div>

        {/* Top-center: map controls */}
        <div className="absolute left-1/2 top-4 z-20 -translate-x-1/2">
          <div className="flex items-center gap-1 rounded-md border border-border/60 bg-card/80 p-1 backdrop-blur">
            {(Object.keys(STYLES) as StyleKey[]).map((s) => (
              <button key={s} type="button" onClick={() => setStyle(s)}
                className={cn("rounded-sm px-2.5 py-1 text-[10px] uppercase tracking-[0.18em] transition",
                  style === s ? "bg-secondary text-secondary-foreground" : "text-muted-foreground hover:bg-secondary/60 hover:text-foreground"
                )}>{s}</button>
            ))}
            <div className="mx-1 h-4 w-px bg-border/60" />
            <button type="button" onClick={toggle3D} aria-pressed={is3D}
              className={cn("flex items-center gap-1 rounded-sm px-2 py-1 text-[10px] uppercase tracking-[0.18em] transition",
                is3D ? "bg-secondary text-secondary-foreground" : "text-muted-foreground hover:bg-secondary/60 hover:text-foreground"
              )}><Cube size={12} weight={is3D ? "fill" : "regular"} /> 3D</button>
            <button type="button" onClick={resetView}
              className="flex items-center rounded-sm px-2 py-1 text-muted-foreground transition hover:bg-secondary/60 hover:text-foreground"
              aria-label="Reset view"><ArrowsCounterClockwise size={12} /></button>
          </div>
        </div>

        {/* Top-right: launch + activity stream */}
        <div className="absolute right-4 top-4 z-30 flex items-center gap-2">
          <button type="button" onClick={startAgents} disabled={agentRunning || loadingRoutes || agents.length === 0}
            className={cn("flex items-center gap-2 rounded-md border border-border/60 bg-card/80 px-3 py-1.5 text-[10px] uppercase tracking-[0.18em] backdrop-blur transition",
              agentRunning || loadingRoutes || agents.length === 0 ? "cursor-not-allowed text-muted-foreground/50" : "text-foreground hover:bg-card"
            )}>
            <Play size={12} weight={agentRunning ? "regular" : "fill"} />
            {loadingRoutes ? "Loading…" : agentRunning ? "Walking…" : agents.length === 0 ? "No Agents" : "Launch"}
          </button>
          <button type="button" onClick={() => setActivityOpen((o) => !o)} aria-pressed={activityOpen}
            className={cn("flex items-center gap-2 rounded-md border border-border/60 bg-card/80 px-3 py-1.5 text-[10px] uppercase tracking-[0.18em] backdrop-blur transition",
              activityOpen ? "text-foreground" : "text-muted-foreground hover:text-foreground"
            )}><WaveSine size={12} /> Activity</button>
        </div>

        {/* Right: activity stream panel */}
        <aside aria-hidden={!activityOpen}
          className={cn("absolute bottom-4 right-4 top-14 z-10 w-72 overflow-hidden rounded-md border border-border/60 bg-card/85 backdrop-blur transition-all duration-200 ease-out",
            activityOpen ? "translate-x-0 opacity-100" : "pointer-events-none translate-x-4 opacity-0"
          )}>
          <div className="flex items-center justify-between border-b border-border/60 px-3 py-2">
            <span className="text-[10px] uppercase tracking-[0.18em] text-foreground">Activity Stream</span>
            <WaveSine size={12} className="text-muted-foreground" />
          </div>
          <div className="flex h-full min-h-[160px] flex-col items-center justify-center gap-1 p-4">
            <p className="text-[11px] uppercase tracking-[0.18em] text-muted-foreground">No activity</p>
            <p className="text-[10px] text-muted-foreground/70">Events will appear here.</p>
          </div>
        </aside>

        {/* Agent profile popup */}
        {selectedAgent && (
          <div className="absolute z-40 w-72 animate-in fade-in zoom-in-95 duration-200"
            style={{ left: Math.min(profilePos.x - 144, (typeof window !== "undefined" ? window.innerWidth : 800) - 300), top: Math.max(profilePos.y - 280, 10) }}>
            <div className="relative rounded-md border border-border/60 bg-card/95 p-4 shadow-2xl backdrop-blur">
              <button type="button" onClick={() => setSelectedAgent(null)}
                className="absolute right-2 top-2 rounded p-1 text-muted-foreground transition hover:bg-secondary/60 hover:text-foreground"
                aria-label="Close profile"><X size={12} /></button>
              <div className="flex items-center gap-3">
                <div className="size-14 overflow-hidden rounded-full border-2" style={{ borderColor: selectedAgent.color + "55" }}>
                  <Avatar style={{ width: "100%", height: "100%" }} {...selectedAgent.config} />
                </div>
                <div>
                  <h3 className="text-sm font-semibold text-foreground">{selectedAgent.name}</h3>
                  <span className="flex items-center gap-1.5 text-[10px] uppercase tracking-[0.18em] text-emerald-400">
                    <span className="inline-block size-1.5 rounded-full bg-emerald-400" />Active
                  </span>
                </div>
              </div>
              <div className="mt-3 border-t border-border/60 pt-3">
                <p className="text-xs leading-relaxed text-muted-foreground">{selectedAgent.personality}</p>
                {selectedAgent.job_description && (
                  <p className="mt-1 text-xs text-muted-foreground"><span className="text-foreground/70">Job:</span> {selectedAgent.job_description}</p>
                )}
                {selectedAgent.age && (
                  <p className="mt-1 text-xs text-muted-foreground"><span className="text-foreground/70">Age:</span> {selectedAgent.age}</p>
                )}
              </div>
              <div className="mt-3 flex flex-wrap gap-1.5 text-[10px] uppercase tracking-[0.18em] text-muted-foreground">
                <span className="rounded-sm px-1.5 py-0.5" style={{ backgroundColor: selectedAgent.color + "22", color: selectedAgent.color }}>Walking</span>
                <span className="rounded-sm bg-secondary/60 px-1.5 py-0.5">{selectedAgent.zone} → {selectedAgent.destZone}</span>
              </div>
            </div>
            <div className="mx-auto h-3 w-3 -translate-y-px rotate-45 border-b border-r border-border/60 bg-card/95" />
          </div>
        )}
      </div>

      {/* Bottom: timeline drawer */}
      <div className="shrink-0 border-t border-border/60 bg-card/85 backdrop-blur">
        <div className="flex items-center justify-between px-4 py-2">
          <button type="button" onClick={() => setTimelineOpen((o) => !o)} aria-expanded={timelineOpen}
            className="flex items-center gap-2 text-[10px] uppercase tracking-[0.18em] text-muted-foreground transition hover:text-foreground">
            <span>Timeline</span>
            {timelineOpen ? <CaretDown size={12} /> : <CaretUp size={12} />}
          </button>
          <div className="flex items-center gap-3">
            <span className="text-[10px] uppercase tracking-[0.18em] text-muted-foreground">Speed</span>
            <input type="range" min={0.25} max={5} step={0.25} value={speed}
              onChange={(e) => setSpeed(parseFloat(e.target.value))}
              className="h-1 w-24 cursor-pointer accent-foreground" />
            <span className="font-mono text-[10px] tabular-nums text-foreground">{speed.toFixed(2)}x</span>
          </div>
        </div>
        <div className={cn("overflow-hidden transition-[max-height] duration-300 ease-out", timelineOpen ? "max-h-64" : "max-h-0")}>
          <div className="border-t border-border/60 px-4 py-6">
            <div className="flex h-48 items-center justify-center rounded-md border border-dashed border-border/60 text-[11px] uppercase tracking-[0.18em] text-muted-foreground">
              Timeline
            </div>
          </div>
        </div>
      </div>
    </div>
  )
}

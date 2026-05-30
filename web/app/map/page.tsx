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
  Crosshair,
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

const COLORS = ["#ff5577", "#7dd3fc", "#fb923c", "#34d399", "#c084fc", "#facc15", "#f472b6", "#a3e635"]

const MAX_FRAMES = 240
const PULSE_COLOR = "#f59e0b" // amber: citywide movement
const AGENT_BACKDROP_COLOR = "#52525b" // zinc: dimmed population reference

type TimelineFrame = {
  total: number // sum of per-tick displacement across all agents (in degrees)
  perAgent: Record<string, number>
}

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
  zoneIndex: number
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

async function geocode(place: string): Promise<[number, number] | null> {
  try {
    const res = await fetch(
      `https://api.mapbox.com/search/geocode/v6/forward?q=${encodeURIComponent(place + ", Seattle WA")}&limit=1&access_token=${TOKEN}`
    )
    const data = await res.json()
    const coords = data.features?.[0]?.geometry?.coordinates
    return coords ? [coords[0], coords[1]] : null
  } catch { return null }
}

async function thinkAgent(agent: Agent, currentLocation: string, memories: { activity: string }[], simTime?: Date): Promise<{ activity: string; destination: string; reasoning: string; duration_minutes?: number } | null> {
  try {
    const res = await fetch("/api/agent/think", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ agent, currentLocation, memories, simTime: simTime?.toISOString() }),
    })
    return await res.json()
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
  const [activityOpen, setActivityOpen] = useState(false)
  const [timelineOpen, setTimelineOpen] = useState(false)
  const [agentRunning, setAgentRunning] = useState(false)
  const [speed, setSpeed] = useState(1)
  const [selectedAgent, setSelectedAgent] = useState<Agent | null>(null)
  const [agents, setAgents] = useState<Agent[]>([])
  const [loadingRoutes, setLoadingRoutes] = useState(false)
  const agentsRef = useRef<Agent[]>([])
  const [frames, setFrames] = useState<TimelineFrame[]>([])
  const framesRef = useRef<TimelineFrame[]>([])
  const positionsRef = useRef<[number, number][]>([])
  const followingIndexRef = useRef<number | null>(null)
  const followTargetRef = useRef<{ zoom: number; pitch: number }>({ zoom: 16.5, pitch: 55 })
  const [followingIndex, setFollowingIndex] = useState<number | null>(null)
  const runningRef = useRef(false)
  const simTimeRef = useRef(new Date(new Date().setHours(8, 0, 0, 0)))
  const [simTime, setSimTime] = useState("08:00 AM")
  const [activities, setActivities] = useState<{ name: string; activity: string; reasoning: string }[]>([])

  // Fetch agents from Supabase
  useEffect(() => {
    supabase.from("agents").select("*").then(({ data }) => {
      if (!data || data.length === 0) return
      const mapped: Agent[] = data.map((row, i) => {
        const startIdx = i % ZONES.length
        const startZone = ZONES[startIdx]
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
          zoneIndex: startIdx,
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
      maxZoom: 22,
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
      if (idx !== undefined && idx !== null) {
        setSelectedAgent(agentsRef.current[idx])
        followingIndexRef.current = idx
        setFollowingIndex(idx)
        followTargetRef.current = { zoom: 16.5, pitch: 55 }
        enable3D(map)
        const pos = positionsRef.current[idx] ?? agentsRef.current[idx]?.start
        if (pos) {
          map.flyTo({
            center: pos,
            zoom: 16.5,
            pitch: 55,
            bearing: map.getBearing(),
            speed: 1.1,
            curve: 1.4,
            essential: true,
          })
        }
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

  // Simulated clock: 5 sim minutes per real second at 1x
  useEffect(() => {
    if (!agentRunning) return
    const interval = setInterval(() => {
      simTimeRef.current = new Date(simTimeRef.current.getTime() + 5 * 60 * 1000 * speed)
      const h = simTimeRef.current.getHours()
      const m = simTimeRef.current.getMinutes()
      const ampm = h >= 12 ? "PM" : "AM"
      const h12 = h % 12 || 12
      setSimTime(`${h12.toString().padStart(2, "0")}:${m.toString().padStart(2, "0")} ${ampm}`)
    }, 1000)
    return () => clearInterval(interval)
  }, [agentRunning, speed])

  // Autonomous cycle for a single agent
  const cycleAgent = useCallback(async (agentIdx: number) => {
    const map = mapRef.current
    const currentAgents = agentsRef.current
    if (!map || !runningRef.current || !currentAgents[agentIdx]) return

    const agent = currentAgents[agentIdx]
    const currentPos = positionsRef.current[agentIdx] || agent.start

    const decision = await thinkAgent(agent, agent.zone, [], simTimeRef.current)
    if (!decision || !runningRef.current) return

    const durationMin = Math.min(decision.duration_minutes || 5, 60)
    const stayDuration = (durationMin * 1000) / speed

    setActivities((prev) => [{ name: agent.name, activity: `${decision.activity} (${durationMin}min)`, reasoning: decision.reasoning }, ...prev].slice(0, 50))

    const dest = await geocode(decision.destination)
    const end = dest || agent.end
    const route = await fetchRoute(currentPos, end)
    if (!route || !runningRef.current) {
      const t = setTimeout(() => cycleAgent(agentIdx), 5000)
      timersRef.current.push(t)
      return
    }

    const smooth = interpolateRoute(route, 3)
    let i = 0
    const step = () => {
      if (!runningRef.current) return
      if (i >= smooth.length) {
        positionsRef.current[agentIdx] = smooth[smooth.length - 1]
        const t = setTimeout(() => cycleAgent(agentIdx), stayDuration)
        timersRef.current.push(t)
        return
      }
      positionsRef.current[agentIdx] = smooth[i]
      i++
      const t = setTimeout(step, speedRef.current)
      timersRef.current.push(t)
    }
    step()
  }, [speed])

  // Render loop for autonomous mode
  useEffect(() => {
    if (!agentRunning || !runningRef.current) return
    const interval = setInterval(() => {
      const map = mapRef.current
      const currentAgents = agentsRef.current
      if (!map || !map.getSource("agents-src") || currentAgents.length === 0) return
      const collection: GeoJSON.FeatureCollection = {
        type: "FeatureCollection",
        features: positionsRef.current.map((pos, i) => ({
          type: "Feature" as const,
          properties: { agentIndex: i, color: currentAgents[i]?.color || "#fff" },
          geometry: { type: "Point" as const, coordinates: pos },
        })),
      };
      (map.getSource("agents-src") as mapboxgl.GeoJSONSource).setData(collection)
    }, 33)
    return () => clearInterval(interval)
  }, [agentRunning])

  const stopAgents = useCallback(() => {
    runningRef.current = false
    timersRef.current.forEach(clearTimeout)
    timersRef.current = []
    setAgentRunning(false)
  }, [])

  const startAgents = useCallback(async () => {
    const map = mapRef.current
    const currentAgents = agentsRef.current
    if (!map || currentAgents.length === 0) return

    setAgentRunning(true)
    setLoadingRoutes(true)
    runningRef.current = true
    setActivities([])
    framesRef.current = []
    setFrames([])
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
    positionsRef.current = currentPositions

    if (map.getSource("agents-src")) {
      (map.getSource("agents-src") as mapboxgl.GeoJSONSource).setData(makeCollection(currentPositions))
    } else {
      map.addSource("agents-src", { type: "geojson", data: makeCollection(currentPositions) })
      map.addLayer({
        id: "agents-glow", type: "circle", source: "agents-src",
        paint: {
          "circle-radius": ["interpolate", ["linear"], ["zoom"], 12, 10, 17, 20, 21, 40],
          "circle-color": ["get", "color"], "circle-opacity": 0.2, "circle-blur": 1,
        },
      })
      map.addLayer({
        id: "agents-dot", type: "circle", source: "agents-src",
        paint: {
          "circle-radius": ["interpolate", ["linear"], ["zoom"], 12, 5, 17, 10, 21, 20],
          "circle-color": ["get", "color"], "circle-stroke-width": 1.5, "circle-stroke-color": "#fff",
        },
      })
    }

    const indices = new Array(currentAgents.length).fill(0)
    let done = false

    const step = () => {
      if (done) return
      let allDone = true
      const frame: TimelineFrame = { total: 0, perAgent: {} }
      for (let i = 0; i < currentAgents.length; i++) {
        const a = currentAgents[i]
        if (indices[i] < smoothRoutes[i].length) {
          const prev = currentPositions[i]
          const next = smoothRoutes[i][indices[i]]
          const dx = next[0] - prev[0]
          const dy = next[1] - prev[1]
          const d = Math.sqrt(dx * dx + dy * dy)
          currentPositions[i] = next
          indices[i]++
          allDone = false
          frame.total += d
          frame.perAgent[a.id] = d
        } else {
          frame.perAgent[a.id] = 0
        }
      }
      const nextFrames = framesRef.current.length >= MAX_FRAMES
        ? [...framesRef.current.slice(framesRef.current.length - MAX_FRAMES + 1), frame]
        : [...framesRef.current, frame]
      framesRef.current = nextFrames
      setFrames(nextFrames)
      ;(map.getSource("agents-src") as mapboxgl.GeoJSONSource).setData(makeCollection(currentPositions))
      const fi = followingIndexRef.current
      if (fi !== null && fi >= 0 && currentPositions[fi]) {
        const route = smoothRoutes[fi]
        const i = indices[fi]
        let desiredBearing = map.getBearing()
        if (route && route.length > 1) {
          // Average direction over the next ~12 steps so heading reads as a smooth curve, not a jitter
          const here = currentPositions[fi]
          const ahead = route[Math.min(route.length - 1, i + 12)]
          const dx = ahead[0] - here[0]
          const dy = ahead[1] - here[1]
          if (dx * dx + dy * dy > 1e-12) {
            desiredBearing = (Math.atan2(dx, dy) * 180) / Math.PI
          }
        }
        // Shortest-arc lerp from current bearing toward desired, so we never spin the long way
        const current = map.getBearing()
        let delta = ((desiredBearing - current + 540) % 360) - 180
        const bearing = current + delta * 0.18 // soft heading follow
        const target = followTargetRef.current
        map.easeTo({
          center: currentPositions[fi],
          zoom: target.zoom,
          pitch: target.pitch,
          bearing,
          // Run the ease ~3 ticks long with a cubic ease so each tick smoothly
          // hands off to the next instead of snapping at every step boundary
          duration: speedRef.current * 3,
          easing: (t) => t * (2 - t),
          essential: true,
        })
      }
      if (allDone) {
        // Initial animation done — start autonomous cycles
        setLoadingRoutes(false)
        currentAgents.forEach((_, i) => {
          const delay = i * 1000
          const t = setTimeout(() => cycleAgent(i), delay)
          timersRef.current.push(t)
        })
        return
      }
      const t = setTimeout(step, speedRef.current)
      timersRef.current.push(t)
    }
    step()
  }, [])

  const enable3D = useCallback((map: mapboxgl.Map) => {
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
    setIs3D(true)
  }, [])

  const disable3D = useCallback((map: mapboxgl.Map) => {
    map.easeTo({ pitch: 0, bearing: 0 })
    if (map.getLayer("3d-buildings")) map.removeLayer("3d-buildings")
    setIs3D(false)
  }, [])

  const toggle3D = () => {
    const map = mapRef.current
    if (!map) return
    if (is3D) disable3D(map)
    else enable3D(map)
  }

  const stopFollowing = useCallback(() => {
    followingIndexRef.current = null
    setFollowingIndex(null)
  }, [])

  const closeProfile = useCallback(() => {
    setSelectedAgent(null)
    stopFollowing()
  }, [stopFollowing])

  const resetView = () => {
    stopFollowing()
    setSelectedAgent(null)
    mapRef.current?.flyTo({ center: SEATTLE_CENTER, zoom: 12, pitch: 0, bearing: 0 })
    if (mapRef.current?.getLayer("3d-buildings")) mapRef.current.removeLayer("3d-buildings")
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
            <span className="font-mono text-xs tracking-[0.18em] text-foreground tabular-nums">{agentRunning ? simTime : time}</span>
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
          <button type="button" onClick={agentRunning ? stopAgents : startAgents} disabled={!agentRunning && (loadingRoutes || agents.length === 0)}
            className={cn("flex items-center gap-2 rounded-md border border-border/60 bg-card/80 px-3 py-1.5 text-[10px] uppercase tracking-[0.18em] backdrop-blur transition",
              !agentRunning && (loadingRoutes || agents.length === 0) ? "cursor-not-allowed text-muted-foreground/50" : "text-foreground hover:bg-card"
            )}>
            <Play size={12} weight={agentRunning ? "regular" : "fill"} />
            {loadingRoutes ? "Loading…" : agentRunning ? "Stop" : agents.length === 0 ? "No Agents" : "Launch"}
          </button>
          <button type="button" onClick={() => setActivityOpen((o) => !o)} aria-pressed={activityOpen}
            className={cn("flex items-center gap-2 rounded-md border border-border/60 bg-card/80 px-3 py-1.5 text-[10px] uppercase tracking-[0.18em] backdrop-blur transition",
              activityOpen ? "text-foreground" : "text-muted-foreground hover:text-foreground"
            )}><WaveSine size={12} /> Activity</button>
        </div>

        {/* Right rail: activity stream + agent profile */}
        <aside
          className="absolute bottom-4 right-4 top-14 z-10 flex w-72 flex-col gap-2"
          aria-hidden={!activityOpen && !selectedAgent}
        >
          <div
            className={cn(
              "flex flex-col overflow-hidden rounded-md border border-border/60 bg-card/85 backdrop-blur transition-all duration-200 ease-out",
              activityOpen
                ? "translate-x-0 opacity-100"
                : "pointer-events-none translate-x-4 opacity-0",
              selectedAgent ? "h-44 flex-none" : "flex-1 min-h-0",
            )}
          >
            <div className="flex items-center justify-between border-b border-border/60 px-3 py-2">
              <span className="text-[10px] uppercase tracking-[0.18em] text-foreground">Activity Stream</span>
              <WaveSine size={12} className="text-muted-foreground" />
            </div>
            <div className="flex flex-1 flex-col gap-1 overflow-y-auto p-3">
              {activities.length === 0 ? (
                <div className="flex flex-1 flex-col items-center justify-center gap-1">
                  <p className="text-[11px] uppercase tracking-[0.18em] text-muted-foreground">No activity</p>
                  <p className="text-[10px] text-muted-foreground/70">Launch agents to see decisions.</p>
                </div>
              ) : (
                activities.map((a, i) => (
                  <div key={i} className="rounded border border-border/40 px-2 py-1.5">
                    <p className="text-[11px] font-medium text-foreground">{a.name}</p>
                    <p className="text-[10px] text-muted-foreground">{a.activity}</p>
                  </div>
                ))
              )}
            </div>
          </div>

          {selectedAgent && (
            <div className="flex flex-1 min-h-0 flex-col overflow-hidden rounded-md border border-border/60 bg-card/95 backdrop-blur animate-in fade-in slide-in-from-right-2 duration-200">
              <div className="flex items-center justify-between border-b border-border/60 px-3 py-2">
                <span className="text-[10px] uppercase tracking-[0.18em] text-foreground">Unit Profile</span>
                <div className="flex items-center gap-1">
                  <button
                    type="button"
                    onClick={() => {
                      const map = mapRef.current
                      const idx = followingIndexRef.current
                      if (map && idx !== null && positionsRef.current[idx]) {
                        followTargetRef.current = { zoom: 16.5, pitch: 55 }
                        map.flyTo({
                          center: positionsRef.current[idx],
                          zoom: 16.5,
                          pitch: 55,
                          speed: 1.1,
                          curve: 1.4,
                          essential: true,
                        })
                      }
                    }}
                    className={cn(
                      "rounded-sm p-1 transition",
                      followingIndex !== null
                        ? "text-emerald-400 hover:bg-secondary/60"
                        : "text-muted-foreground hover:bg-secondary/60 hover:text-foreground",
                    )}
                    aria-label="Recenter on unit"
                    title="Recenter"
                  >
                    <Crosshair size={12} weight={followingIndex !== null ? "fill" : "regular"} />
                  </button>
                  <button
                    type="button"
                    onClick={closeProfile}
                    className="rounded-sm p-1 text-muted-foreground transition hover:bg-secondary/60 hover:text-foreground"
                    aria-label="Close profile"
                  >
                    <X size={12} />
                  </button>
                </div>
              </div>

              <div className="flex items-center gap-3 border-b border-border/60 px-3 py-3">
                <div
                  className="size-12 shrink-0 overflow-hidden rounded-full border-2"
                  style={{ borderColor: selectedAgent.color + "66" }}
                >
                  <Avatar style={{ width: "100%", height: "100%" }} {...selectedAgent.config} />
                </div>
                <div className="min-w-0 flex-1">
                  <h3 className="truncate text-sm font-semibold text-foreground">{selectedAgent.name}</h3>
                  <span className="mt-0.5 flex items-center gap-1.5 text-[10px] uppercase tracking-[0.18em] text-emerald-400">
                    <span className="inline-block size-1.5 rounded-full bg-emerald-400 shadow-[0_0_6px_0_var(--color-emerald-400,#34d399)]" />
                    {followingIndex !== null ? "Tracking" : "Active"}
                  </span>
                </div>
              </div>

              <div className="flex-1 overflow-y-auto">
                <DiagRow label="Target" value={`${selectedAgent.name.split(" ")[0].toUpperCase()}[${zoneCode(selectedAgent.zone)}]`} accentColor={selectedAgent.color} />
                <DiagRow label="Zone" value={`${zoneCode(selectedAgent.zone)} → ${zoneCode(selectedAgent.destZone)}`} />
                <DiagRow label="Status" value={agentRunning ? "Walking" : "Idle"} />
                {selectedAgent.age != null && <DiagRow label="Age" value={String(selectedAgent.age)} />}
                {selectedAgent.location_home && <DiagRow label="Home" value={selectedAgent.location_home} />}
                {selectedAgent.location_work && <DiagRow label="Work" value={selectedAgent.location_work} />}

                {selectedAgent.personality && (
                  <div className="border-t border-border/60 px-3 py-3">
                    <div className="text-[10px] uppercase tracking-[0.18em] text-muted-foreground">Personality</div>
                    <p className="mt-2 text-xs leading-relaxed text-foreground/85">{selectedAgent.personality}</p>
                  </div>
                )}
                {selectedAgent.job_description && (
                  <div className="border-t border-border/60 px-3 py-3">
                    <div className="text-[10px] uppercase tracking-[0.18em] text-muted-foreground">Job</div>
                    <p className="mt-2 text-xs leading-relaxed text-foreground/85">{selectedAgent.job_description}</p>
                  </div>
                )}
              </div>
            </div>
          )}
        </aside>
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
          <div className="border-t border-border/60 px-4 py-4">
            <TimelineChart
              frames={frames}
              selectedAgent={selectedAgent}
              totalAgents={agents.length}
              running={agentRunning}
            />
          </div>
        </div>
      </div>
    </div>
  )
}

const ZONE_NAME_TO_CODE: Record<string, string> = {
  "Downtown Seattle": "DOWN",
  "South Lake Union": "SLU",
  Bellevue: "BELL",
  Redmond: "RED",
  Sammamish: "SAMM",
}

function zoneCode(zoneName: string): string {
  return ZONE_NAME_TO_CODE[zoneName] ?? zoneName.slice(0, 4).toUpperCase()
}

function DiagRow({
  label,
  value,
  accentColor,
}: {
  label: string
  value: string
  accentColor?: string
}) {
  return (
    <div className="flex items-center justify-between border-t border-border/60 px-3 py-2 first:border-t-0">
      <span className="text-[10px] uppercase tracking-[0.18em] text-muted-foreground">{label}</span>
      <span
        className="font-mono text-[11px] tracking-tight text-foreground"
        style={accentColor ? { color: accentColor } : undefined}
      >
        {value}
      </span>
    </div>
  )
}

function TimelineChart({
  frames,
  selectedAgent,
  totalAgents,
  running,
}: {
  frames: TimelineFrame[]
  selectedAgent: Agent | null
  totalAgents: number
  running: boolean
}) {
  const wrapRef = useRef<HTMLDivElement>(null)
  const [size, setSize] = useState({ w: 800, h: 192 })
  const [hover, setHover] = useState<{ idx: number; x: number; y: number } | null>(null)

  useEffect(() => {
    const el = wrapRef.current
    if (!el) return
    const update = () => setSize({ w: el.clientWidth, h: el.clientHeight })
    update()
    const ro = new ResizeObserver(update)
    ro.observe(el)
    return () => ro.disconnect()
  }, [])

  const padL = 16
  const padR = 16
  const padT = 14
  const padB = 22
  const W = Math.max(320, size.w)
  const H = Math.max(140, size.h)
  const innerW = Math.max(10, W - padL - padR)
  const innerH = Math.max(10, H - padT - padB)

  const smooth = (vals: number[], win: number) => {
    if (vals.length === 0) return vals
    const half = Math.floor(win / 2)
    return vals.map((_, i) => {
      const a = Math.max(0, i - half)
      const b = Math.min(vals.length - 1, i + half)
      let s = 0
      for (let k = a; k <= b; k++) s += vals[k]
      return s / (b - a + 1)
    })
  }

  // Per-agent average movement so agent + city share an axis
  const popRaw = frames.map((f) => (totalAgents > 0 ? f.total / totalAgents : 0))
  const pop = smooth(popRaw, 7)
  const agentRaw = selectedAgent ? frames.map((f) => f.perAgent[selectedAgent.id] ?? 0) : []
  const agent = smooth(agentRaw, 7)

  const maxV = Math.max(1e-12, ...pop, ...agent)
  const xStep = frames.length > 1 ? innerW / (frames.length - 1) : innerW
  const xAt = (i: number) => padL + i * xStep
  const yAt = (v: number) => padT + innerH - (v / maxV) * innerH * 0.92

  const buildSmoothPath = (values: number[]) => {
    if (values.length === 0) return ""
    if (values.length === 1) return `M${xAt(0)},${yAt(values[0])}`
    const pts = values.map((v, i) => [xAt(i), yAt(v)] as const)
    let d = `M${pts[0][0]},${pts[0][1]}`
    for (let i = 0; i < pts.length - 1; i++) {
      const p0 = pts[i - 1] ?? pts[i]
      const p1 = pts[i]
      const p2 = pts[i + 1]
      const p3 = pts[i + 2] ?? p2
      const c1x = p1[0] + (p2[0] - p0[0]) / 6
      const c1y = p1[1] + (p2[1] - p0[1]) / 6
      const c2x = p2[0] - (p3[0] - p1[0]) / 6
      const c2y = p2[1] - (p3[1] - p1[1]) / 6
      d += ` C${c1x},${c1y} ${c2x},${c2y} ${p2[0]},${p2[1]}`
    }
    return d
  }

  const closeArea = (linePath: string) => {
    if (!linePath || frames.length === 0) return ""
    return `${linePath} L${xAt(frames.length - 1)},${padT + innerH} L${xAt(0)},${padT + innerH} Z`
  }

  const popLine = buildSmoothPath(pop)
  const popArea = closeArea(popLine)
  const agentLine = selectedAgent ? buildSmoothPath(agent) : ""
  const agentArea = closeArea(agentLine)

  const focused = !!selectedAgent
  const popStroke = focused ? AGENT_BACKDROP_COLOR : PULSE_COLOR
  const popFillId = focused ? "grad-pop-dim" : "grad-pop"

  const gridYs = [0, 0.25, 0.5, 0.75, 1].map((p) => padT + innerH * p)

  const hoverIdx = hover ? hover.idx : -1
  const hoverPop = hoverIdx >= 0 ? pop[hoverIdx] ?? 0 : 0
  const hoverAgent = hoverIdx >= 0 && selectedAgent ? agent[hoverIdx] ?? 0 : 0
  const hoverPopPct = (hoverPop / maxV) * 100
  const hoverAgentPct = (hoverAgent / maxV) * 100

  const onMove = (e: React.MouseEvent<HTMLDivElement>) => {
    if (frames.length === 0) return
    const r = e.currentTarget.getBoundingClientRect()
    const x = e.clientX - r.left
    if (x < padL - 4 || x > padL + innerW + 4) {
      setHover(null)
      return
    }
    const rel = Math.min(innerW, Math.max(0, x - padL))
    const idx = frames.length > 1 ? Math.round(rel / xStep) : 0
    setHover({ idx, x: xAt(idx), y: e.clientY - r.top })
  }

  return (
    <div
      ref={wrapRef}
      className="relative h-48 w-full overflow-hidden rounded-md border border-border/60 bg-[#0a0a0c]/70"
      onMouseMove={onMove}
      onMouseLeave={() => setHover(null)}
    >
      <svg width={W} height={H} className="absolute inset-0 block">
        <defs>
          <linearGradient id="grad-pop" x1="0" y1="0" x2="0" y2="1">
            <stop offset="0%" stopColor={PULSE_COLOR} stopOpacity={0.55} />
            <stop offset="100%" stopColor={PULSE_COLOR} stopOpacity={0.04} />
          </linearGradient>
          <linearGradient id="grad-pop-dim" x1="0" y1="0" x2="0" y2="1">
            <stop offset="0%" stopColor={AGENT_BACKDROP_COLOR} stopOpacity={0.35} />
            <stop offset="100%" stopColor={AGENT_BACKDROP_COLOR} stopOpacity={0.03} />
          </linearGradient>
          {selectedAgent && (
            <linearGradient id="grad-agent" x1="0" y1="0" x2="0" y2="1">
              <stop offset="0%" stopColor={selectedAgent.color} stopOpacity={0.9} />
              <stop offset="100%" stopColor={selectedAgent.color} stopOpacity={0.1} />
            </linearGradient>
          )}
          <filter id="glow-agent" x="-20%" y="-20%" width="140%" height="140%">
            <feGaussianBlur stdDeviation="2.5" result="b" />
            <feMerge>
              <feMergeNode in="b" />
              <feMergeNode in="SourceGraphic" />
            </feMerge>
          </filter>
        </defs>

        {gridYs.map((y, i) => (
          <line
            key={i}
            x1={padL}
            x2={W - padR}
            y1={y}
            y2={y}
            stroke="rgba(255,255,255,0.04)"
            strokeWidth={1}
          />
        ))}

        {popArea && <path d={popArea} fill={`url(#${popFillId})`} stroke="none" />}
        {popLine && (
          <path
            d={popLine}
            fill="none"
            stroke={popStroke}
            strokeOpacity={focused ? 0.55 : 0.95}
            strokeWidth={focused ? 1 : 1.5}
            strokeLinejoin="round"
            strokeLinecap="round"
          />
        )}

        {selectedAgent && agentArea && (
          <>
            <path d={agentArea} fill="url(#grad-agent)" stroke="none" />
            <path
              d={agentLine}
              fill="none"
              stroke={selectedAgent.color}
              strokeWidth={1.75}
              strokeLinejoin="round"
              strokeLinecap="round"
              filter="url(#glow-agent)"
            />
          </>
        )}

        {hover && (
          <g>
            <line
              x1={hover.x}
              x2={hover.x}
              y1={padT}
              y2={padT + innerH}
              stroke="rgba(255,255,255,0.4)"
              strokeWidth={1}
              strokeDasharray="3 3"
            />
            {selectedAgent && (
              <circle
                cx={hover.x}
                cy={yAt(hoverAgent)}
                r={3.5}
                fill="#0a0a0c"
                stroke={selectedAgent.color}
                strokeWidth={1.5}
              />
            )}
            <circle
              cx={hover.x}
              cy={yAt(hoverPop)}
              r={3.5}
              fill="#0a0a0c"
              stroke={focused ? "rgba(255,255,255,0.65)" : PULSE_COLOR}
              strokeWidth={1.5}
            />
          </g>
        )}
      </svg>

      <div className="pointer-events-none absolute bottom-2 left-4 right-4 flex items-center justify-between font-mono text-[9px] uppercase tracking-[0.22em] text-muted-foreground/70">
        <span>Earlier</span>
        <span>City Movement · Last {frames.length} ticks</span>
        <span>Now</span>
      </div>

      {hover && (
        <div
          className="pointer-events-none absolute z-10 rounded-sm border border-border/70 bg-[#0a0a0c]/95 px-2.5 py-1.5 font-mono text-[10px] uppercase tracking-[0.18em] shadow-xl backdrop-blur"
          style={{
            left: Math.min(hover.x + 12, W - 170),
            top: Math.max(padT, Math.min(yAt(hoverPop), yAt(hoverAgent)) - 36),
          }}
        >
          {selectedAgent ? (
            <>
              <div className="flex items-center gap-1.5">
                <span className="inline-block size-1.5 rounded-full" style={{ backgroundColor: selectedAgent.color }} />
                <span className="text-foreground tabular-nums">{hoverAgentPct.toFixed(1)}%</span>
                <span className="text-muted-foreground">{selectedAgent.name}</span>
              </div>
              <div className="mt-0.5 flex items-center gap-1.5">
                <span className="inline-block size-1.5 rounded-full" style={{ backgroundColor: AGENT_BACKDROP_COLOR }} />
                <span className="text-foreground/70 tabular-nums">{hoverPopPct.toFixed(1)}%</span>
                <span className="text-muted-foreground">City Avg</span>
              </div>
            </>
          ) : (
            <>
              <div className="text-muted-foreground">City Movement</div>
              <div className="mt-0.5 text-foreground tabular-nums">{hoverPopPct.toFixed(1)}%</div>
            </>
          )}
        </div>
      )}

      {frames.length === 0 && (
        <div className="absolute inset-0 flex items-center justify-center">
          <span className="font-mono text-[10px] uppercase tracking-[0.18em] text-muted-foreground">
            {running ? "Awaiting telemetry…" : "Press launch to begin telemetry"}
          </span>
        </div>
      )}

      <div className="pointer-events-none absolute left-3 top-2 flex items-center gap-3 font-mono text-[10px] uppercase tracking-[0.18em]">
        {selectedAgent ? (
          <>
            <span className="flex items-center gap-1.5">
              <span className="inline-block size-1.5 rounded-full" style={{ backgroundColor: selectedAgent.color }} />
              <span className="text-foreground">{selectedAgent.name}</span>
            </span>
            <span className="flex items-center gap-1.5 text-muted-foreground">
              <span className="inline-block size-1.5 rounded-full" style={{ backgroundColor: AGENT_BACKDROP_COLOR }} />
              City Avg
            </span>
          </>
        ) : (
          <span className="flex items-center gap-1.5">
            <span className="inline-block size-1.5 rounded-full" style={{ backgroundColor: PULSE_COLOR }} />
            <span className="text-foreground">City Movement</span>
          </span>
        )}
      </div>
    </div>
  )
}

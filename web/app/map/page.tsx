"use client"

import { useEffect, useRef, useState, useCallback } from "react"
import dynamic from "next/dynamic"
import mapboxgl from "mapbox-gl"
import "mapbox-gl/dist/mapbox-gl.css"
import { genConfig } from "react-nice-avatar"
import type { AvatarFullConfig, NiceAvatarProps } from "react-nice-avatar"
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

// Greater Seattle area (roughly Tacoma -> Everett, Bainbridge -> Bellevue)
const SEATTLE_CENTER: [number, number] = [-122.3321, 47.6062]
const SEATTLE_BOUNDS: [[number, number], [number, number]] = [
  [-122.65, 47.35],
  [-122.05, 47.9],
]

const START: [number, number] = [-122.3425, 47.6097]
const END: [number, number] = [-122.3399, 47.6062]

const AGENT = {
  name: "Atlas",
  personality:
    "A curious urban explorer who loves discovering hidden gems in the city. Methodical and observant, always taking the scenic route.",
  config: genConfig(),
}

async function fetchRoute(
  start: [number, number],
  end: [number, number]
): Promise<[number, number][]> {
  const res = await fetch(
    `https://api.mapbox.com/directions/v5/mapbox/walking/${start[0]},${start[1]};${end[0]},${end[1]}?geometries=geojson&steps=true&access_token=${TOKEN}`
  )
  const data = await res.json()
  return data.routes[0].geometry.coordinates
}

// Interpolate between route points for smoother movement
function interpolateRoute(
  coords: [number, number][],
  stepsPerSegment: number
): [number, number][] {
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
  const timerRef = useRef<ReturnType<typeof setTimeout> | null>(null)
  const speedRef = useRef(200)
  const [style, setStyle] = useState<StyleKey>("Dark")
  const [is3D, setIs3D] = useState(false)
  const [time, setTime] = useState("--:--:--")
  const [activityOpen, setActivityOpen] = useState(true)
  const [timelineOpen, setTimelineOpen] = useState(false)
  const [agentRunning, setAgentRunning] = useState(false)
  const [speed, setSpeed] = useState(1)
  const [showProfile, setShowProfile] = useState(false)
  const [profilePos, setProfilePos] = useState<{ x: number; y: number }>({
    x: 0,
    y: 0,
  })

  useEffect(() => {
    speedRef.current = 200 / speed
  }, [speed])

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
    map.addControl(
      new mapboxgl.NavigationControl({
        visualizePitch: true,
        showCompass: false,
      }),
      "bottom-right"
    )
    mapRef.current = map

    map.on("click", "agent-dot", (e) => {
      const point = e.point
      setProfilePos({ x: point.x, y: point.y })
      setShowProfile(true)
    })

    map.on("mouseenter", "agent-dot", () => {
      map.getCanvas().style.cursor = "pointer"
    })
    map.on("mouseleave", "agent-dot", () => {
      map.getCanvas().style.cursor = ""
    })

    return () => {
      if (timerRef.current) clearTimeout(timerRef.current)
      map.remove()
    }
  }, [style])

  useEffect(() => {
    const tick = () => {
      const d = new Date()
      const pad = (n: number) => n.toString().padStart(2, "0")
      setTime(
        `${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}`
      )
    }
    tick()
    const id = setInterval(tick, 1000)
    return () => clearInterval(id)
  }, [])

  const startAgent = useCallback(async () => {
    const map = mapRef.current
    if (!map) return

    setAgentRunning(true)
    setShowProfile(false)
    map.flyTo({ center: START, zoom: 16, duration: 800 })
    const route = await fetchRoute(START, END)
    const smoothRoute = interpolateRoute(route, 5)

    if (map.getSource("route")) {
      ;(map.getSource("route") as mapboxgl.GeoJSONSource).setData({
        type: "Feature",
        properties: {},
        geometry: { type: "LineString", coordinates: route },
      })
    } else {
      map.addSource("route", {
        type: "geojson",
        data: {
          type: "Feature",
          properties: {},
          geometry: { type: "LineString", coordinates: route },
        },
      })
      map.addLayer({
        id: "route-line",
        type: "line",
        source: "route",
        paint: {
          "line-color": "#4882c5",
          "line-width": 3,
          "line-opacity": 0.6,
          "line-dasharray": [2, 1],
        },
      })
    }

    const agentData: GeoJSON.Feature<GeoJSON.Point> = {
      type: "Feature",
      properties: {},
      geometry: { type: "Point", coordinates: smoothRoute[0] },
    }
    if (map.getSource("agent")) {
      ;(map.getSource("agent") as mapboxgl.GeoJSONSource).setData(agentData)
    } else {
      map.addSource("agent", { type: "geojson", data: agentData })
      map.addLayer({
        id: "agent-glow",
        type: "circle",
        source: "agent",
        paint: {
          "circle-radius": 14,
          "circle-color": "#ff4444",
          "circle-opacity": 0.2,
          "circle-blur": 1,
        },
      })
      map.addLayer({
        id: "agent-dot",
        type: "circle",
        source: "agent",
        paint: {
          "circle-radius": 7,
          "circle-color": "#ff4444",
          "circle-stroke-width": 2.5,
          "circle-stroke-color": "#fff",
        },
      })
    }

    let i = 0
    const step = () => {
      if (i >= smoothRoute.length) {
        setAgentRunning(false)
        return
      }
      ;(map.getSource("agent") as mapboxgl.GeoJSONSource).setData({
        type: "Feature",
        properties: {},
        geometry: { type: "Point", coordinates: smoothRoute[i] },
      })
      i++
      timerRef.current = setTimeout(step, speedRef.current)
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
            map.addSource("composite", {
              type: "vector",
              url: "mapbox://mapbox.mapbox-streets-v8",
            })
          }
          map.addLayer({
            id: "3d-buildings",
            source: "composite",
            "source-layer": "building",
            type: "fill-extrusion",
            minzoom: 14,
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
    mapRef.current?.flyTo({
      center: SEATTLE_CENTER,
      zoom: 12,
      pitch: 0,
      bearing: 0,
    })
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
            <span className="font-mono text-xs tracking-[0.18em] text-foreground tabular-nums">
              {time}
            </span>
          </div>
          <span className="hidden text-[10px] uppercase tracking-[0.2em] text-muted-foreground sm:inline">
            Sector 05 · Map View
          </span>
        </div>

        {/* Top-center: map controls */}
        <div className="absolute left-1/2 top-4 z-20 -translate-x-1/2">
          <div className="flex items-center gap-1 rounded-md border border-border/60 bg-card/80 p-1 backdrop-blur">
            {(Object.keys(STYLES) as StyleKey[]).map((s) => (
              <button
                key={s}
                type="button"
                onClick={() => setStyle(s)}
                className={cn(
                  "rounded-sm px-2.5 py-1 text-[10px] uppercase tracking-[0.18em] transition",
                  style === s
                    ? "bg-secondary text-secondary-foreground"
                    : "text-muted-foreground hover:bg-secondary/60 hover:text-foreground"
                )}
              >
                {s}
              </button>
            ))}
            <div className="mx-1 h-4 w-px bg-border/60" />
            <button
              type="button"
              onClick={toggle3D}
              aria-pressed={is3D}
              className={cn(
                "flex items-center gap-1 rounded-sm px-2 py-1 text-[10px] uppercase tracking-[0.18em] transition",
                is3D
                  ? "bg-secondary text-secondary-foreground"
                  : "text-muted-foreground hover:bg-secondary/60 hover:text-foreground"
              )}
            >
              <Cube size={12} weight={is3D ? "fill" : "regular"} />
              3D
            </button>
            <button
              type="button"
              onClick={resetView}
              className="flex items-center rounded-sm px-2 py-1 text-muted-foreground transition hover:bg-secondary/60 hover:text-foreground"
              aria-label="Reset view"
            >
              <ArrowsCounterClockwise size={12} />
            </button>
          </div>
        </div>

        {/* Top-right: launch + activity stream toggle */}
        <div className="absolute right-4 top-4 z-30 flex items-center gap-2">
          <button
            type="button"
            onClick={startAgent}
            disabled={agentRunning}
            className={cn(
              "flex items-center gap-2 rounded-md border border-border/60 bg-card/80 px-3 py-1.5 text-[10px] uppercase tracking-[0.18em] backdrop-blur transition",
              agentRunning
                ? "cursor-not-allowed text-muted-foreground/50"
                : "text-foreground hover:bg-card"
            )}
          >
            <Play size={12} weight={agentRunning ? "regular" : "fill"} />
            {agentRunning ? "Walking…" : "Launch"}
          </button>
          <button
            type="button"
            onClick={() => setActivityOpen((o) => !o)}
            aria-pressed={activityOpen}
            className={cn(
              "flex items-center gap-2 rounded-md border border-border/60 bg-card/80 px-3 py-1.5 text-[10px] uppercase tracking-[0.18em] backdrop-blur transition",
              activityOpen
                ? "text-foreground"
                : "text-muted-foreground hover:text-foreground"
            )}
          >
            <WaveSine size={12} />
            Activity Stream
          </button>
        </div>

        {/* Right: activity stream panel */}
        <aside
          aria-hidden={!activityOpen}
          className={cn(
            "absolute bottom-4 right-4 top-14 z-10 w-72 overflow-hidden rounded-md border border-border/60 bg-card/85 backdrop-blur transition-all duration-200 ease-out",
            activityOpen
              ? "translate-x-0 opacity-100"
              : "pointer-events-none translate-x-4 opacity-0"
          )}
        >
          <div className="flex items-center justify-between border-b border-border/60 px-3 py-2">
            <span className="text-[10px] uppercase tracking-[0.18em] text-foreground">
              Activity Stream
            </span>
            <WaveSine size={12} className="text-muted-foreground" />
          </div>
          <div className="flex h-full min-h-[160px] flex-col items-center justify-center gap-1 p-4">
            <p className="text-[11px] uppercase tracking-[0.18em] text-muted-foreground">
              No activity
            </p>
            <p className="text-[10px] text-muted-foreground/70">
              Events will appear here.
            </p>
          </div>
        </aside>

        {/* Agent profile popup */}
        {showProfile && (
          <div
            className="absolute z-40 w-72 animate-in fade-in zoom-in-95 duration-200"
            style={{ left: profilePos.x - 144, top: profilePos.y - 260 }}
          >
            <div className="relative rounded-md border border-border/60 bg-card/95 p-4 shadow-2xl backdrop-blur">
              <button
                type="button"
                onClick={() => setShowProfile(false)}
                className="absolute right-2 top-2 rounded p-1 text-muted-foreground transition hover:bg-secondary/60 hover:text-foreground"
                aria-label="Close profile"
              >
                <X size={12} />
              </button>
              <div className="flex items-center gap-3">
                <div className="size-14 overflow-hidden rounded-full border-2 border-primary/30">
                  <Avatar
                    style={{ width: "100%", height: "100%" }}
                    {...AGENT.config}
                  />
                </div>
                <div>
                  <h3 className="text-sm font-semibold text-foreground">
                    {AGENT.name}
                  </h3>
                  <span className="flex items-center gap-1.5 text-[10px] uppercase tracking-[0.18em] text-emerald-400">
                    <span className="inline-block size-1.5 rounded-full bg-emerald-400" />
                    Active
                  </span>
                </div>
              </div>
              <div className="mt-3 border-t border-border/60 pt-3">
                <p className="text-xs leading-relaxed text-muted-foreground">
                  {AGENT.personality}
                </p>
              </div>
              <div className="mt-3 flex flex-wrap gap-1.5 text-[10px] uppercase tracking-[0.18em] text-muted-foreground">
                <span className="rounded-sm bg-secondary/60 px-1.5 py-0.5">
                  Walking
                </span>
                <span className="rounded-sm bg-secondary/60 px-1.5 py-0.5">
                  Pike Place → Waterfront
                </span>
              </div>
            </div>
            <div className="mx-auto h-3 w-3 -translate-y-px rotate-45 border-b border-r border-border/60 bg-card/95" />
          </div>
        )}
      </div>

      {/* Bottom: timeline drawer */}
      <div className="shrink-0 border-t border-border/60 bg-card/85 backdrop-blur">
        <div className="flex items-center justify-between px-4 py-2">
          <button
            type="button"
            onClick={() => setTimelineOpen((o) => !o)}
            aria-expanded={timelineOpen}
            className="flex items-center gap-2 text-[10px] uppercase tracking-[0.18em] text-muted-foreground transition hover:text-foreground"
          >
            <span>Timeline</span>
            {timelineOpen ? <CaretDown size={12} /> : <CaretUp size={12} />}
          </button>
          <div className="flex items-center gap-3">
            <span className="text-[10px] uppercase tracking-[0.18em] text-muted-foreground">
              Speed
            </span>
            <input
              type="range"
              min={0.25}
              max={5}
              step={0.25}
              value={speed}
              onChange={(e) => setSpeed(parseFloat(e.target.value))}
              className="h-1 w-24 cursor-pointer accent-foreground"
            />
            <span className="font-mono text-[10px] tabular-nums text-foreground">
              {speed.toFixed(2)}x
            </span>
          </div>
        </div>
        <div
          className={cn(
            "overflow-hidden transition-[max-height] duration-300 ease-out",
            timelineOpen ? "max-h-64" : "max-h-0"
          )}
        >
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

"use client"

import { useEffect, useRef, useState } from "react"
import mapboxgl from "mapbox-gl"
import "mapbox-gl/dist/mapbox-gl.css"
import {
  ArrowsCounterClockwise,
  CaretDown,
  CaretUp,
  Cube,
  WaveSine,
} from "@phosphor-icons/react/dist/ssr"

import { cn } from "@/lib/utils"

const TOKEN = process.env.NEXT_PUBLIC_MAPBOX_TOKEN!

const STYLES = {
  Dark: "mapbox://styles/mapbox/dark-v11",
  Light: "mapbox://styles/mapbox/light-v11",
  Streets: "mapbox://styles/mapbox/streets-v12",
  Satellite: "mapbox://styles/mapbox/satellite-streets-v12",
} as const

type StyleKey = keyof typeof STYLES

// Greater Seattle area (roughly Everett -> Tacoma, Bainbridge -> Bellevue)
const SEATTLE_CENTER: [number, number] = [-122.3321, 47.6062]
const SEATTLE_BOUNDS: [[number, number], [number, number]] = [
  [-122.65, 47.35], // SW
  [-122.05, 47.9], // NE
]

export default function MapPage() {
  const mapContainer = useRef<HTMLDivElement>(null)
  const mapRef = useRef<mapboxgl.Map | null>(null)
  const [style, setStyle] = useState<StyleKey>("Dark")
  const [is3D, setIs3D] = useState(false)
  const [time, setTime] = useState("--:--:--")
  const [activityOpen, setActivityOpen] = useState(true)
  const [timelineOpen, setTimelineOpen] = useState(false)

  useEffect(() => {
    const map = new mapboxgl.Map({
      container: mapContainer.current!,
      accessToken: TOKEN,
      style: STYLES[style],
      center: SEATTLE_CENTER,
      zoom: 10.5,
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
      new mapboxgl.NavigationControl({ visualizePitch: true, showCompass: false }),
      "bottom-right"
    )
    mapRef.current = map

    return () => map.remove()
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
      zoom: 10.5,
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

      {/* Top-right: activity stream toggle */}
      <div className="absolute right-4 top-4 z-30">
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
      </div>

      {/* Bottom: timeline drawer (in normal flow, pushes map region up) */}
      <div className="shrink-0 border-t border-border/60 bg-card/85 backdrop-blur">
        <button
          type="button"
          onClick={() => setTimelineOpen((o) => !o)}
          aria-expanded={timelineOpen}
          className="flex w-full items-center justify-between px-4 py-2 text-[10px] uppercase tracking-[0.18em] text-muted-foreground transition hover:text-foreground"
        >
          <span>Timeline</span>
          {timelineOpen ? <CaretDown size={12} /> : <CaretUp size={12} />}
        </button>
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

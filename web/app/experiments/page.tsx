"use client"

import { useCallback, useEffect, useMemo, useRef, useState } from "react"
import mapboxgl from "mapbox-gl"
import "mapbox-gl/dist/mapbox-gl.css"
import type { Icon as PhosphorIcon } from "@phosphor-icons/react"
import {
  ArrowsCounterClockwise,
  CaretDown,
  CaretUp,
  Clock,
  Cloud,
  CloudFog,
  CloudLightning,
  CloudRain,
  CloudSnow,
  CloudSun,
  Crosshair,
  Cube,
  FastForward,
  Fire,
  Gauge,
  Path,
  Pause,
  Play,
  Rewind,
  Snowflake,
  Sun,
  Wind,
} from "@phosphor-icons/react/dist/ssr"

import { cn } from "@/lib/utils"

const TOKEN = process.env.NEXT_PUBLIC_MAPBOX_TOKEN!

const STYLES = {
  Dark: "mapbox://styles/mapbox/dark-v11",
  Light: "mapbox://styles/mapbox/light-v11",
  Streets: "mapbox://styles/mapbox/streets-v12",
} as const

type StyleKey = keyof typeof STYLES

const SEATTLE_CENTER: [number, number] = [-122.3321, 47.6062]
const SEATTLE_BOUNDS: [[number, number], [number, number]] = [
  [-122.65, 47.35],
  [-122.05, 47.9],
]

type LngLat = [number, number]

type Travel = {
  mode: "walking" | "driving" | "cycling"
  polyline: LngLat[]
  duration_minutes: number
}

type Beat = {
  index: number
  start_time: string
  end_time: string
  activity: string
  activity_type: string
  location_name: string
  location: LngLat
  travel_from_prev: Travel | null
  reasoning: string
}

type Plan = {
  sim_date: string
  day_number: number
  agent_id: string
  agent_name: string
  status: string
  beats: Beat[]
  diary: string
  thought_process: string
  end_state: { location: LngLat; energy: number; notes: string }
  world_event_prompt: string
  generated_at: string
  stats: Record<string, number | boolean>
}

type PlanFile = { file: string; data: Plan }

const ACTIVITY_COLORS: Record<string, string> = {
  home: "#64748b",
  sleep: "#312e81",
  work: "#06b6d4",
  meal: "#f97316",
  errand: "#a855f7",
  social: "#ec4899",
  exercise: "#22c55e",
  leisure: "#eab308",
  commute: "#f59e0b",
  other: "#94a3b8",
}

// `v` = sim_seconds per real_second. v=900 means 15 sim min per real sec.
const SPEEDS: { label: string; v: number }[] = [
  { label: "1m/s", v: 60 },
  { label: "5m/s", v: 300 },
  { label: "15m/s", v: 900 },
  { label: "30m/s", v: 1_800 },
  { label: "1h/s", v: 3_600 },
  { label: "3h/s", v: 10_800 },
]

type WeatherKind =
  | "sunny"
  | "hot"
  | "cold"
  | "rain"
  | "storm"
  | "snow"
  | "cloudy"
  | "fog"
  | "smoke"
  | "wind"
  | "partly_cloudy"
  | "unknown"

type Weather = {
  kind: WeatherKind
  label: string
  tempF: number | null
  Icon: PhosphorIcon
}

function parseWeather(prompt: string): Weather | null {
  const lower = prompt.toLowerCase()
  let tempF: number | null = null
  const t = lower.match(/(-?\d{2,3})\s?°?\s?f\b/)
  if (t) tempF = Number(t[1])
  const ck = (re: RegExp) => re.test(lower)
  let kind: WeatherKind = "unknown"
  let label = ""
  if (ck(/snow|blizzard/)) { kind = "snow"; label = "Snow" }
  else if (ck(/thunder|lightning|storm/)) { kind = "storm"; label = "Storm" }
  else if (ck(/heavy rain|downpour/)) { kind = "rain"; label = "Heavy rain" }
  else if (ck(/rain|drizzle|showers/)) { kind = "rain"; label = "Rain" }
  else if (ck(/fog|mist/)) { kind = "fog"; label = "Fog" }
  else if (ck(/wildfire|smoke|smoky|hazy|haze/)) { kind = "smoke"; label = "Wildfire smoke" }
  else if (ck(/wind|breezy|gusty/)) { kind = "wind"; label = "Windy" }
  else if (ck(/overcast|cloudy/)) { kind = "cloudy"; label = "Cloudy" }
  else if (ck(/partly|partial/)) { kind = "partly_cloudy"; label = "Partly cloudy" }
  else if (ck(/sunny|sunshine|sun\b|clear/)) { kind = "sunny"; label = "Sunny" }
  else if (ck(/heat|hot\b/) || (tempF != null && tempF >= 85)) { kind = "hot"; label = "Hot" }
  else if (ck(/cold|freezing|chilly/) || (tempF != null && tempF <= 35)) { kind = "cold"; label = "Cold" }
  if (kind === "unknown" && tempF == null) return null
  if (!label && tempF != null) {
    kind = tempF >= 85 ? "hot" : tempF <= 35 ? "cold" : "sunny"
    label = tempF >= 85 ? "Hot" : tempF <= 35 ? "Cold" : "Clear"
  }
  const iconMap: Record<WeatherKind, PhosphorIcon> = {
    sunny: Sun,
    hot: Fire,
    cold: Snowflake,
    rain: CloudRain,
    storm: CloudLightning,
    snow: CloudSnow,
    cloudy: Cloud,
    fog: CloudFog,
    smoke: CloudFog,
    wind: Wind,
    partly_cloudy: CloudSun,
    unknown: Cloud,
  }
  return { kind, label, tempF, Icon: iconMap[kind] }
}

function fmtTime(iso: string): string {
  return new Date(iso).toLocaleTimeString("en-US", {
    hour: "2-digit",
    minute: "2-digit",
    hour12: false,
    timeZone: "America/Los_Angeles",
  })
}

function fmtClockFromOffset(offsetMs: number, baseMs: number): string {
  return new Date(baseMs + offsetMs).toLocaleTimeString("en-US", {
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
    hour12: false,
    timeZone: "America/Los_Angeles",
  })
}

function durMin(beat: Beat): number {
  return Math.max(
    1,
    Math.round(
      (new Date(beat.end_time).getTime() - new Date(beat.start_time).getTime()) /
        60000,
    ),
  )
}

// Pure: given the offset within a day, resolve the cursor's position,
// active-beat index, and whether we're in a stay or a travel phase.
// Reads no React state — safe to call from RAF.
type CursorResolved = {
  pos: LngLat
  beat: Beat
  activeIdx: number
  phase: "travel" | "stay"
}

function resolveCursor(
  plan: Plan,
  dayStartMs: number,
  offsetMs: number,
): CursorResolved {
  const tNow = dayStartMs + offsetMs
  let activeIdx = 0
  for (let i = 0; i < plan.beats.length; i++) {
    const b = plan.beats[i]
    if (new Date(b.end_time).getTime() >= tNow) {
      activeIdx = i
      break
    }
    activeIdx = i
  }
  const beat = plan.beats[activeIdx]
  const beatStart = new Date(beat.start_time).getTime()
  const beatEnd = new Date(beat.end_time).getTime()
  const prevBeat = activeIdx > 0 ? plan.beats[activeIdx - 1] : null
  const prevEnd = prevBeat ? new Date(prevBeat.end_time).getTime() : beatStart
  let pos: LngLat = beat.location
  let phase: "travel" | "stay" = "stay"
  if (tNow < beatStart && beat.travel_from_prev && prevBeat) {
    const span = beatStart - prevEnd
    const frac = span > 0 ? Math.max(0, Math.min(1, (tNow - prevEnd) / span)) : 1
    pos = interpolateAlong(
      beat.travel_from_prev.polyline,
      frac,
      prevBeat.location,
      beat.location,
    )
    phase = "travel"
  } else if (tNow >= beatStart && tNow <= beatEnd) {
    pos = beat.location
  } else {
    pos = beat.location
  }
  return { pos, beat, activeIdx, phase }
}

export default function ExperimentsPage() {
  const [plans, setPlans] = useState<PlanFile[]>([])
  const [selectedFile, setSelectedFile] = useState<string | null>(null)
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)
  const [style, setStyle] = useState<StyleKey>("Dark")
  const [is3D, setIs3D] = useState(false)
  const [timelineOpen, setTimelineOpen] = useState(true)
  const [showPaths, setShowPaths] = useState(false)
  const [following, setFollowing] = useState(false)
  const [slowTransit, setSlowTransit] = useState(true)

  useEffect(() => {
    fetch("/api/experiments/plans")
      .then((r) => r.json())
      .then((j: { plans: PlanFile[] }) => {
        setPlans(j.plans)
        if (j.plans.length > 0) setSelectedFile(j.plans[0].file)
      })
      .catch((e) => setError(String(e)))
      .finally(() => setLoading(false))
  }, [])

  const selected = plans.find((p) => p.file === selectedFile) ?? null

  return (
    <div className="flex h-svh max-h-svh w-full flex-col overflow-hidden bg-background text-foreground">
      {selected ? (
        <PlanReplay
          key={selected.file}
          plan={selected.data}
          plans={plans}
          selectedFile={selectedFile}
          loading={loading}
          setSelectedFile={setSelectedFile}
          style={style}
          setStyle={setStyle}
          is3D={is3D}
          setIs3D={setIs3D}
          timelineOpen={timelineOpen}
          setTimelineOpen={setTimelineOpen}
          showPaths={showPaths}
          setShowPaths={setShowPaths}
          following={following}
          setFollowing={setFollowing}
          slowTransit={slowTransit}
          setSlowTransit={setSlowTransit}
        />
      ) : (
        <div className="flex h-full items-center justify-center text-sm text-muted-foreground">
          {loading
            ? "loading plans..."
            : error
              ? error
              : "no plans found in experiments/output/plans/"}
        </div>
      )}
    </div>
  )
}

function PlanReplay(props: {
  plan: Plan
  plans: PlanFile[]
  selectedFile: string | null
  loading: boolean
  setSelectedFile: (v: string) => void
  style: StyleKey
  setStyle: (v: StyleKey) => void
  is3D: boolean
  setIs3D: (v: boolean) => void
  timelineOpen: boolean
  setTimelineOpen: (v: boolean) => void
  showPaths: boolean
  setShowPaths: (v: boolean) => void
  following: boolean
  setFollowing: (v: boolean) => void
  slowTransit: boolean
  setSlowTransit: (v: boolean) => void
}) {
  const {
    plan,
    plans,
    selectedFile,
    loading,
    setSelectedFile,
    style,
    setStyle,
    is3D,
    setIs3D,
    timelineOpen,
    setTimelineOpen,
    showPaths,
    setShowPaths,
    following,
    setFollowing,
    slowTransit,
    setSlowTransit,
  } = props

  const containerRef = useRef<HTMLDivElement | null>(null)
  const mapRef = useRef<mapboxgl.Map | null>(null)
  const markersRef = useRef<mapboxgl.Marker[]>([])
  const mapLoadedRef = useRef(false)
  const userPannedRef = useRef(false)

  const dayStartMs = new Date(plan.beats[0].start_time).getTime()
  const dayEndMs = new Date(plan.beats[plan.beats.length - 1].end_time).getTime()
  const dayLen = Math.max(1, dayEndMs - dayStartMs)

  const [offsetMs, setOffsetMs] = useState(0)
  const [playing, setPlaying] = useState(false)
  const [speed, setSpeed] = useState(900)
  // Only the active-beat *identity* needs to re-render the side panels.
  // The cursor's continuous (lng, lat) lives in a ref + the GeoJSON source.
  const [activeBeat, setActiveBeat] = useState<{
    idx: number
    phase: "travel" | "stay"
  }>({ idx: 0, phase: "stay" })

  const playingRef = useRef(playing)
  const speedRef = useRef(speed)
  const offsetRef = useRef(offsetMs)
  const followingRef = useRef(following)
  const slowTransitRef = useRef(slowTransit)
  const is3DRef = useRef(is3D)
  // Smoothed camera bearing (degrees). Updated each RAF when following.
  const bearingRef = useRef(0)
  // Tight 3D chase target — mirrors the live `/map` follow camera so the
  // experiment replay tracks the agent just as closely (fixed close zoom +
  // 55° pitch) instead of a loose top-down pan.
  const followTargetRef = useRef<{ zoom: number; pitch: number }>({
    zoom: 16.5,
    pitch: 55,
  })
  // Last-committed active-beat identity (used to avoid React churn).
  const activeBeatRef = useRef<{ idx: number; phase: "travel" | "stay" }>({
    idx: 0,
    phase: "stay",
  })
  playingRef.current = playing
  speedRef.current = speed
  offsetRef.current = offsetMs
  followingRef.current = following
  slowTransitRef.current = slowTransit
  is3DRef.current = is3D

  // Sorted [startOffsetMs, endOffsetMs] spans where the cursor is in transit.
  const travelSpans = useMemo(() => {
    const spans: { s: number; e: number }[] = []
    for (let i = 1; i < plan.beats.length; i++) {
      const b = plan.beats[i]
      if (!b.travel_from_prev) continue
      const prev = plan.beats[i - 1]
      const s = new Date(prev.end_time).getTime() - dayStartMs
      const e = new Date(b.start_time).getTime() - dayStartMs
      if (e > s) spans.push({ s, e })
    }
    return spans
  }, [plan, dayStartMs])
  const travelSpansRef = useRef(travelSpans)
  travelSpansRef.current = travelSpans

  // Init map (runs once per plan since key={selected.file} on the parent)
  useEffect(() => {
    if (!containerRef.current || mapRef.current) return
    mapboxgl.accessToken = TOKEN
    const map = new mapboxgl.Map({
      container: containerRef.current,
      style: STYLES[style],
      center: SEATTLE_CENTER,
      zoom: 11,
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
    map.addControl(
      new mapboxgl.NavigationControl({
        visualizePitch: true,
        showCompass: false,
      }),
      "bottom-right",
    )
    mapRef.current = map

    const onLoad = () => {
      mapLoadedRef.current = true
      installLayers(map, plan)
      installMarkers(map, plan, markersRef, (idx) => {
        // Clicking a beat marker scrubs there and enables follow.
        const beat = plan.beats[idx]
        const t = new Date(beat.start_time).getTime() - dayStartMs
        setOffsetMs(Math.max(0, t))
        setPlaying(false)
        userPannedRef.current = false
        followingRef.current = true
        bearingRef.current = map.getBearing()
        setFollowing(true)
        setIs3D(true)
      })
      fitToPlan(map, plan)
      // Beat-marker layer click (handled by DOM markers above, but also
      // listen for clicks on the cursor dot to toggle follow).
      map.on("click", "cursor-dot", () => {
        userPannedRef.current = false
        followingRef.current = true
        bearingRef.current = map.getBearing()
        setFollowing(true)
        setIs3D(true)
      })
      map.on("mouseenter", "cursor-dot", () => {
        map.getCanvas().style.cursor = "pointer"
      })
      map.on("mouseleave", "cursor-dot", () => {
        map.getCanvas().style.cursor = ""
      })
      // Any user-initiated movement breaks follow mode. Flip the ref
      // synchronously so the in-flight RAF tick doesn't tug the camera
      // back during the user's drag. We listen only to `dragstart` (which
      // mapbox fires for user gestures only) — `rotatestart`/`movestart`
      // also fire for programmatic easeTo, which would self-cancel follow.
      map.on("dragstart", () => {
        if (followingRef.current) {
          userPannedRef.current = true
          followingRef.current = false
          setFollowing(false)
        }
      })
      map.on("wheel", () => {
        if (followingRef.current) {
          userPannedRef.current = true
          followingRef.current = false
          setFollowing(false)
        }
      })
    }
    map.on("load", onLoad)

    // Keep the map canvas in sync with its container size (handles the
    // bottom timeline drawer's open/close transition, window resizes, etc.)
    const ro = new ResizeObserver(() => {
      try {
        map.resize()
      } catch {
        // ignore
      }
    })
    ro.observe(containerRef.current)

    return () => {
      ro.disconnect()
      mapLoadedRef.current = false
      for (const m of markersRef.current) {
        try {
          m.remove()
        } catch {
          // ignore
        }
      }
      markersRef.current = []
      try {
        map.remove()
      } catch {
        // ignore
      }
      mapRef.current = null
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  // Style swap
  useEffect(() => {
    const map = mapRef.current
    if (!map || !mapLoadedRef.current) return
    map.setStyle(STYLES[style])
    const onStyle = () => {
      installLayers(map, plan)
      // Markers are DOM children of the canvas container, which setStyle does
      // not wipe — they persist. So don't reinstall.
      if (is3D) enable3D(map)
      // Re-apply path visibility
      const vis = showPaths ? "visible" : "none"
      if (map.getLayer("routes-line"))
        map.setLayoutProperty("routes-line", "visibility", vis)
    }
    map.once("style.load", onStyle)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [style])

  // 3D toggle
  useEffect(() => {
    const map = mapRef.current
    if (!map || !mapLoadedRef.current) return
    if (is3D) enable3D(map)
    else disable3D(map)
  }, [is3D])

  // Path visibility toggle — hides route lines AND numbered beat markers.
  // The agent cursor (pulse + dot) always stays visible.
  useEffect(() => {
    const map = mapRef.current
    if (!map || !mapLoadedRef.current) return
    if (map.getLayer("routes-line")) {
      map.setLayoutProperty(
        "routes-line",
        "visibility",
        showPaths ? "visible" : "none",
      )
    }
    for (const m of markersRef.current) {
      const el = m.getElement()
      if (el) el.style.display = showPaths ? "" : "none"
    }
  }, [showPaths])

  // Single RAF loop: advance the sim clock, write the cursor's position
  // straight into the GeoJSON source, and update the follow camera with
  // bearing smoothing — all without round-tripping through React state.
  // Mirrors the live-map page's per-step easeTo pattern.
  useEffect(() => {
    let raf = 0
    let last = performance.now()
    // Throttle bookkeeping. The camera's easeTo needs duration ≈ 3× the
    // call interval to chain smoothly without each call interrupting the
    // previous one (this is what `/map` does with `speedRef.current * 3`).
    let lastCamMs = 0
    let lastTrailMs = 0
    const CAM_INTERVAL = 80
    const CAM_DURATION = 240
    const TRAIL_INTERVAL = 140
    const tick = (now: number) => {
      const dt = now - last
      last = now
      if (playingRef.current) {
        let effSpeed = speedRef.current
        if (slowTransitRef.current) {
          const cur = offsetRef.current
          for (const span of travelSpansRef.current) {
            if (cur >= span.s && cur <= span.e) {
              effSpeed *= 0.25
              break
            }
            if (span.s > cur) break
          }
        }
        const next = offsetRef.current + dt * effSpeed
        if (next >= dayLen) {
          offsetRef.current = dayLen
          setOffsetMs(dayLen)
          setPlaying(false)
        } else {
          offsetRef.current = next
          setOffsetMs(next)
        }
      }

      const map = mapRef.current
      if (map && mapLoadedRef.current) {
        const cur = resolveCursor(plan, dayStartMs, offsetRef.current)

        // Cursor source — direct write every frame, no React re-render.
        const src = map.getSource("cursor") as mapboxgl.GeoJSONSource | undefined
        if (src) {
          src.setData({
            type: "FeatureCollection",
            features: [
              {
                type: "Feature",
                geometry: { type: "Point", coordinates: cur.pos },
                properties: {},
              },
            ],
          })
        }

        // Trail — throttled. Recomputes the breadcrumb LineString from
        // `offsetMs`, so scrubbing back/forward also shrinks/grows it.
        if (now - lastTrailMs >= TRAIL_INTERVAL) {
          lastTrailMs = now
          const trailSrc = map.getSource("trail") as
            | mapboxgl.GeoJSONSource
            | undefined
          if (trailSrc) {
            const coords = computeTrail(plan, dayStartMs, offsetRef.current)
            trailSrc.setData({
              type: "FeatureCollection",
              features:
                coords.length >= 2
                  ? [
                      {
                        type: "Feature",
                        properties: {},
                        geometry: {
                          type: "LineString",
                          coordinates: coords,
                        },
                      },
                    ]
                  : [],
            })
          }
        }

        // Follow camera — throttled easeTo with look-ahead bearing smoothing.
        // Mirrors the live `/map` follow: a fixed close zoom + 55° pitch 3D
        // chase with a heading averaged over the look-ahead so turns read as
        // a curve rather than per-frame jitter.
        if (followingRef.current && now - lastCamMs >= CAM_INTERVAL) {
          lastCamMs = now
          const ahead = resolveCursor(
            plan,
            dayStartMs,
            Math.min(dayLen, offsetRef.current + 1500),
          )
          const dx = ahead.pos[0] - cur.pos[0]
          const dy = ahead.pos[1] - cur.pos[1]
          const curBearing = map.getBearing()
          let bearing = curBearing
          if (dx * dx + dy * dy > 1e-12) {
            const desired = (Math.atan2(dx, dy) * 180) / Math.PI
            const delta = ((desired - curBearing + 540) % 360) - 180
            bearing = curBearing + delta * 0.18
            bearingRef.current = bearing
          }
          const target = followTargetRef.current
          map.easeTo({
            center: cur.pos,
            zoom: target.zoom,
            pitch: target.pitch,
            bearing,
            duration: CAM_DURATION,
            easing: (t) => t * (2 - t),
            essential: true,
          })
        }

        // Re-render side panels only when the beat identity actually changes.
        if (
          cur.activeIdx !== activeBeatRef.current.idx ||
          cur.phase !== activeBeatRef.current.phase
        ) {
          activeBeatRef.current = { idx: cur.activeIdx, phase: cur.phase }
          setActiveBeat({ idx: cur.activeIdx, phase: cur.phase })
        }
      }

      raf = requestAnimationFrame(tick)
    }
    raf = requestAnimationFrame(tick)
    return () => cancelAnimationFrame(raf)
  }, [dayLen, plan, dayStartMs])

  const toggle = useCallback(() => {
    if (offsetRef.current >= dayLen) setOffsetMs(0)
    setPlaying((p) => !p)
  }, [dayLen])

  const reset = useCallback(() => {
    setPlaying(false)
    setOffsetMs(0)
  }, [])

  const stepBeat = useCallback(
    (dir: -1 | 1) => {
      const tNow = dayStartMs + offsetRef.current
      const targets = plan.beats
        .map((b) => new Date(b.start_time).getTime())
        .sort((a, b) => a - b)
      if (dir === 1) {
        const next = targets.find((t) => t > tNow + 1000)
        if (next != null) setOffsetMs(Math.max(0, next - dayStartMs))
      } else {
        const prev = [...targets].reverse().find((t) => t < tNow - 1000)
        if (prev != null) setOffsetMs(Math.max(0, prev - dayStartMs))
      }
      setPlaying(false)
    },
    [plan, dayStartMs],
  )

  const recenter = useCallback(() => {
    const map = mapRef.current
    if (!map) return
    const cur = resolveCursor(plan, dayStartMs, offsetRef.current)
    userPannedRef.current = false
    followingRef.current = true
    bearingRef.current = map.getBearing()
    setFollowing(true)
    setIs3D(true)
    const target = followTargetRef.current
    map.flyTo({
      center: cur.pos,
      zoom: target.zoom,
      pitch: target.pitch,
      speed: 1.2,
      curve: 1.4,
      essential: true,
    })
  }, [plan, dayStartMs, setFollowing, setIs3D])

  const weather = useMemo(
    () => parseWeather(plan.world_event_prompt),
    [plan.world_event_prompt],
  )

  // Rolling activity log — populated when the active beat / phase flips.
  type StreamEntry = {
    id: number
    ts: string
    label: string
    color: string
  }
  const [stream, setStream] = useState<StreamEntry[]>([])
  const streamIdRef = useRef(0)

  // Seed the stream with the day's opening beat so the panel isn't empty on
  // first render. Re-runs when the plan swaps (the parent re-keys this
  // component too, but be defensive).
  useEffect(() => {
    if (plan.beats.length === 0) {
      setStream([])
      return
    }
    const b = plan.beats[0]
    const ts = fmtTime(b.start_time)
    streamIdRef.current = 1
    setStream([
      {
        id: 0,
        ts,
        label: `${b.activity_type} @ ${b.location_name}`,
        color: ACTIVITY_COLORS[b.activity_type] ?? ACTIVITY_COLORS.other,
      },
    ])
  }, [plan])

  // Push an entry every time the active beat or phase changes.
  // Skip the very first run (the seed above already covers it).
  const streamSeededRef = useRef(false)
  useEffect(() => {
    if (!streamSeededRef.current) {
      streamSeededRef.current = true
      return
    }
    const b = plan.beats[activeBeat.idx]
    if (!b) return
    const tNow = dayStartMs + offsetRef.current
    const ts = new Date(tNow).toLocaleTimeString("en-US", {
      hour: "2-digit",
      minute: "2-digit",
      hour12: false,
      timeZone: "America/Los_Angeles",
    })
    let label: string
    let color: string
    if (activeBeat.phase === "travel") {
      const mode = b.travel_from_prev?.mode ?? "moving"
      label = `↗ ${mode} → ${b.location_name}`
      color = "#fbbf24"
    } else {
      label = `${b.activity_type} @ ${b.location_name}`
      color = ACTIVITY_COLORS[b.activity_type] ?? ACTIVITY_COLORS.other
    }
    const id = streamIdRef.current++
    setStream((prev) => [{ id, ts, label, color }, ...prev].slice(0, 60))
  }, [activeBeat, plan, dayStartMs])

  return (
    <>
      {/* TOP BAR */}
      <header className="flex h-10 shrink-0 items-center justify-between border-b border-border/40 bg-[#0a0a0d] px-3 text-[10px] uppercase tracking-[0.18em]">
        <div className="flex items-center gap-3">
          <span className="font-mono font-semibold text-foreground">
            SEALANTIR
          </span>
          <span className="text-muted-foreground/40">//</span>
          <span className="text-muted-foreground">
            Orchestration · Day {plan.day_number}
          </span>
          <span className="text-muted-foreground/30">·</span>
          <span className="font-mono normal-case tracking-normal text-foreground">
            {plan.agent_name}
          </span>
          <span className="text-muted-foreground/30">·</span>
          <span className="font-mono normal-case tracking-normal text-muted-foreground">
            {plan.sim_date}
          </span>
        </div>
        <div className="flex items-center gap-3">
          {weather && (
            <span className="flex items-center gap-1.5 text-muted-foreground">
              <weather.Icon size={12} />
              <span className="normal-case tracking-normal">
                {weather.label}
              </span>
              {weather.tempF != null && (
                <span className="font-mono tabular-nums">
                  {weather.tempF}°F
                </span>
              )}
            </span>
          )}
          <span className="flex items-center gap-1.5 font-mono tabular-nums text-foreground/90">
            <Clock size={11} className="text-muted-foreground" />
            {fmtClockFromOffset(offsetMs, dayStartMs)}
          </span>
          <button
            type="button"
            onClick={toggle}
            className="flex h-7 items-center gap-1.5 rounded-sm bg-amber-500 px-3 font-semibold tracking-[0.18em] text-zinc-950 transition hover:bg-amber-400"
          >
            {playing ? (
              <>
                <Pause size={11} weight="fill" /> Pause
              </>
            ) : offsetMs >= dayLen ? (
              <>
                <ArrowsCounterClockwise size={11} weight="fill" /> Replay
              </>
            ) : (
              <>
                <Play size={11} weight="fill" /> Play
              </>
            )}
          </button>
        </div>
      </header>

      {/* BODY: left rail + map + right rail */}
      <div className="relative flex min-h-0 flex-1 overflow-hidden">
        {/* LEFT RAIL */}
        <aside className="hidden min-h-0 w-56 shrink-0 flex-col overflow-hidden border-r border-border/40 bg-[#0a0a0d] md:flex">
          <div className="flex items-center justify-between border-b border-border/40 px-3 py-2.5 text-[10px] uppercase tracking-[0.22em]">
            <span className="text-muted-foreground/80">Plans</span>
            <span className="font-mono normal-case tracking-normal text-muted-foreground/60">
              {plans.length}
            </span>
          </div>
          <div className="min-h-0 flex-1 overflow-y-auto py-2">
            {Array.from(new Set(plans.map((p) => p.data.agent_name))).map(
              (agent) => {
                const items = plans.filter((p) => p.data.agent_name === agent)
                return (
                  <div key={agent} className="mb-3">
                    <div className="px-3 py-1 text-[9px] uppercase tracking-[0.22em] text-muted-foreground/60">
                      {agent}
                    </div>
                    {items.map((p) => {
                      const active = p.file === selectedFile
                      return (
                        <button
                          key={p.file}
                          type="button"
                          onClick={() => setSelectedFile(p.file)}
                          className={cn(
                            "flex w-full items-center justify-between gap-2 border-l-2 px-3 py-1.5 text-[11px] transition",
                            active
                              ? "border-amber-400 bg-amber-500/10 text-amber-100"
                              : "border-transparent text-muted-foreground hover:bg-secondary/30 hover:text-foreground",
                          )}
                        >
                          <span className="flex items-center gap-2 truncate font-mono">
                            <span
                              className={cn(
                                "size-1.5 rounded-full transition",
                                active
                                  ? "bg-amber-400 shadow-[0_0_6px_0_rgb(245,158,11)]"
                                  : "bg-zinc-600",
                              )}
                            />
                            <span className="truncate">{p.data.sim_date}</span>
                          </span>
                          <span className="font-mono text-[9px] tracking-[0.18em] text-muted-foreground/60">
                            D{p.data.day_number} · {p.data.beats.length}b
                          </span>
                        </button>
                      )
                    })}
                  </div>
                )
              },
            )}
            {plans.length === 0 && (
              <div className="px-3 py-3 text-[11px] text-muted-foreground">
                {loading ? "loading…" : "no plans"}
              </div>
            )}
          </div>

          {/* Layer / control toggles */}
          <div className="border-t border-border/40 px-2 py-2">
            <div className="mb-1.5 px-1 text-[9px] uppercase tracking-[0.22em] text-muted-foreground/60">
              Layers
            </div>
            <div className="grid grid-cols-2 gap-1">
              <RailToggle
                label="Paths"
                active={showPaths}
                onClick={() => setShowPaths(!showPaths)}
                Icon={Path}
              />
              <RailToggle
                label="3D"
                active={is3D}
                onClick={() => setIs3D(!is3D)}
                Icon={Cube}
              />
              <RailToggle
                label="Follow"
                active={following}
                onClick={recenter}
                Icon={Crosshair}
              />
              <RailToggle
                label="Slow"
                active={slowTransit}
                onClick={() => setSlowTransit(!slowTransit)}
                Icon={Gauge}
              />
            </div>
            <div className="mt-2 flex gap-1">
              {(Object.keys(STYLES) as StyleKey[]).map((s) => (
                <button
                  key={s}
                  type="button"
                  onClick={() => setStyle(s)}
                  className={cn(
                    "flex-1 rounded-sm px-1 py-1 text-[9px] uppercase tracking-[0.18em] transition",
                    style === s
                      ? "bg-secondary text-secondary-foreground"
                      : "text-muted-foreground hover:bg-secondary/40 hover:text-foreground",
                  )}
                >
                  {s}
                </button>
              ))}
            </div>
          </div>
        </aside>

        {/* MAP */}
        <div className="relative min-h-0 min-w-0 flex-1 overflow-hidden">
          <div
            ref={containerRef}
            className="absolute inset-0 h-full w-full"
          />

          {/* World event ribbon — top-left of map */}
          <div className="pointer-events-none absolute left-3 top-3 z-10 max-w-md rounded-md border border-border/40 bg-[#0a0a0d]/85 px-3 py-2 text-[10px] backdrop-blur">
            <div className="text-[9px] uppercase tracking-[0.22em] text-muted-foreground/80">
              World event · Day {plan.day_number}
            </div>
            <div className="mt-1 leading-snug text-foreground/90">
              {plan.world_event_prompt}
            </div>
          </div>

          {/* Phase pill — top-right of map */}
          <div className="pointer-events-none absolute right-3 top-3 z-10 flex items-center gap-2 rounded-md border border-border/40 bg-[#0a0a0d]/85 px-2.5 py-1.5 text-[10px] backdrop-blur">
            <span
              className="size-1.5 rounded-full"
              style={{
                backgroundColor:
                  activeBeat.phase === "travel"
                    ? "#fbbf24"
                    : (ACTIVITY_COLORS[
                        plan.beats[activeBeat.idx].activity_type
                      ] ?? ACTIVITY_COLORS.other),
                boxShadow:
                  activeBeat.phase === "travel"
                    ? "0 0 6px 0 rgb(251 191 36 / 0.7)"
                    : "0 0 4px 0 currentColor",
              }}
            />
            <span className="font-mono uppercase tracking-[0.18em] text-muted-foreground">
              {activeBeat.phase === "travel"
                ? "TRANSIT"
                : plan.beats[activeBeat.idx].activity_type}
            </span>
            <span className="font-mono text-foreground/80">
              B{activeBeat.idx + 1}/{plan.beats.length}
            </span>
          </div>
        </div>

        {/* RIGHT RAIL — single scroll region. Everything inside flows
            naturally; the aside itself is the only scrollbar so diary /
            CoT expansion can grow as tall as it needs without ever
            pushing the map, footer, or timeline drawer. */}
        <aside className="hidden min-h-0 w-72 shrink-0 flex-col overflow-y-auto border-l border-border/40 bg-[#0a0a0d] lg:flex">
          {/* Active beat detail */}
          <div className="shrink-0 border-b border-border/40 px-3 py-2.5">
            <div className="flex items-center justify-between text-[9px] uppercase tracking-[0.22em] text-muted-foreground/80">
              <span>Active beat</span>
              <span className="font-mono normal-case tracking-normal text-muted-foreground/60">
                B{activeBeat.idx + 1}/{plan.beats.length}
              </span>
            </div>
            <div className="mt-2 flex items-center gap-2">
              <span
                className="size-2 rounded-full"
                style={{
                  backgroundColor:
                    activeBeat.phase === "travel"
                      ? "#fbbf24"
                      : (ACTIVITY_COLORS[
                          plan.beats[activeBeat.idx].activity_type
                        ] ?? ACTIVITY_COLORS.other),
                  boxShadow:
                    activeBeat.phase === "travel"
                      ? "0 0 6px 0 rgb(251 191 36 / 0.7)"
                      : "0 0 4px 0 currentColor",
                }}
              />
              <span className="text-[10px] uppercase tracking-[0.18em] text-foreground">
                {activeBeat.phase === "travel"
                  ? "In transit"
                  : plan.beats[activeBeat.idx].activity_type}
              </span>
            </div>
            <div className="mt-1.5 text-[12px] leading-snug text-foreground/90">
              {plan.beats[activeBeat.idx].activity}
            </div>
            <div className="mt-0.5 text-[10px] text-muted-foreground">
              {activeBeat.phase === "travel" ? "→ " : "@ "}
              {plan.beats[activeBeat.idx].location_name}
            </div>
            <div className="mt-1.5 font-mono text-[9px] tabular-nums tracking-[0.12em] text-muted-foreground/70">
              {fmtTime(plan.beats[activeBeat.idx].start_time)}–
              {fmtTime(plan.beats[activeBeat.idx].end_time)} ·{" "}
              {durMin(plan.beats[activeBeat.idx])}m
            </div>
          </div>

          {/* Activity stream — capped height with its own scroll because
              entries prepend in real time; we don't want it pushing the
              sections list far down the aside. */}
          <div className="shrink-0 border-b border-border/40">
            <div className="flex items-center justify-between px-3 py-2 text-[9px] uppercase tracking-[0.22em] text-muted-foreground/80">
              <span>Activity stream</span>
              <span className="font-mono normal-case tracking-normal text-muted-foreground/60">
                {stream.length}
              </span>
            </div>
            <div
              className={cn(
                "overflow-y-auto px-2 pb-2 font-mono text-[10px] transition-[max-height] duration-300 ease-out",
                timelineOpen ? "max-h-20" : "max-h-44",
              )}
            >
              {stream.length === 0 && (
                <div className="px-2 py-3 text-muted-foreground/70">
                  (no events yet — press play)
                </div>
              )}
              {stream.map((e) => (
                <div
                  key={e.id}
                  className="mb-0.5 flex items-start gap-2 border-l-2 bg-[#08080b] py-1 pl-2 pr-2 animate-in fade-in slide-in-from-top-1 duration-300"
                  style={{ borderColor: e.color }}
                >
                  <span className="text-amber-200/80">[{e.ts}]</span>
                  <span className="leading-snug text-foreground/85">
                    {e.label}
                  </span>
                </div>
              ))}
            </div>
          </div>

          {/* Diary + beats list + stats — natural flow; the parent aside
              owns the scroll, so any section can be as long as it wants. */}
          <div className="shrink-0">
            <Section title="diary" defaultOpen>
              <div className="px-3 pb-3 text-[11px] leading-relaxed text-foreground/85">
                {plan.diary || (
                  <span className="text-muted-foreground">(none)</span>
                )}
              </div>
            </Section>
            <Section title="thought process">
              <div className="px-3 pb-3 text-[11px] leading-relaxed text-foreground/85">
                {plan.thought_process || (
                  <span className="text-muted-foreground">(none)</span>
                )}
              </div>
            </Section>
            <Section title="beats">
              <div className="px-1 pb-2">
                {plan.beats.map((b) => (
                  <BeatRow
                    key={b.index}
                    beat={b}
                    active={b.index === activeBeat.idx}
                    onClick={() => {
                      const t = new Date(b.start_time).getTime() - dayStartMs
                      setOffsetMs(Math.max(0, t))
                      setPlaying(false)
                    }}
                  />
                ))}
              </div>
            </Section>
            <Section title="stats">
              <pre className="overflow-x-auto px-3 pb-3 text-[10px] leading-relaxed text-foreground/80">
                {JSON.stringify(plan.stats, null, 2)}
              </pre>
            </Section>
          </div>
        </aside>

        {/* Bottom timeline overlay — slides up over the map AND aside so
            toggling it does NOT resize the map. Sits inside the body row
            so the right-rail visually shrinks when it's open. */}
        <div
          className={cn(
            "pointer-events-none absolute inset-x-0 bottom-0 z-20 transition-transform duration-300 ease-out",
            timelineOpen ? "translate-y-0" : "translate-y-full",
          )}
        >
          <div className="pointer-events-auto border-t border-border/40 bg-[#0a0a0d]/95 px-3 pb-3 pt-2 backdrop-blur">
            <BeatTimeline
              plan={plan}
              dayStartMs={dayStartMs}
              dayLen={dayLen}
              offsetMs={offsetMs}
              activeIdx={activeBeat.idx}
              onScrub={(ms) => {
                setOffsetMs(Math.max(0, Math.min(dayLen, ms)))
                setPlaying(false)
              }}
            />
          </div>
        </div>
      </div>

      {/* BOTTOM TRANSPORT + COLLAPSIBLE TIMELINE */}
      <footer className="shrink-0 border-t border-border/40 bg-[#0a0a0d]">
        <div className="flex flex-wrap items-center justify-between gap-3 px-3 py-1.5">
          <div className="flex items-center gap-1">
            <button
              type="button"
              onClick={() => stepBeat(-1)}
              className="flex h-7 w-7 items-center justify-center rounded-sm text-muted-foreground transition hover:bg-secondary/40 hover:text-foreground"
              aria-label="Previous beat"
              title="Previous beat"
            >
              <Rewind size={11} weight="fill" />
            </button>
            <button
              type="button"
              onClick={toggle}
              className="flex h-7 w-7 items-center justify-center rounded-sm bg-secondary/30 text-foreground transition hover:bg-secondary/60"
              aria-label={playing ? "Pause" : "Play"}
            >
              {playing ? (
                <Pause size={11} weight="fill" />
              ) : (
                <Play size={11} weight="fill" />
              )}
            </button>
            <button
              type="button"
              onClick={() => stepBeat(1)}
              className="flex h-7 w-7 items-center justify-center rounded-sm text-muted-foreground transition hover:bg-secondary/40 hover:text-foreground"
              aria-label="Next beat"
              title="Next beat"
            >
              <FastForward size={11} weight="fill" />
            </button>
            <button
              type="button"
              onClick={reset}
              className="ml-1 flex h-7 w-7 items-center justify-center rounded-sm text-muted-foreground transition hover:bg-secondary/40 hover:text-foreground"
              aria-label="Reset"
              title="Reset"
            >
              <ArrowsCounterClockwise size={11} />
            </button>
            <span className="ml-3 font-mono text-[11px] tabular-nums text-foreground">
              {fmtClockFromOffset(offsetMs, dayStartMs)}
            </span>
            <span className="ml-1.5 font-mono text-[10px] tabular-nums text-muted-foreground/70">
              / {fmtClockFromOffset(dayLen, dayStartMs)}
            </span>
            <span className="ml-3 hidden text-[10px] uppercase tracking-[0.18em] text-muted-foreground/60 sm:inline">
              {plan.beats.length} beats · {Math.floor(dayLen / 3_600_000)}h
              {Math.round((dayLen % 3_600_000) / 60_000)}m
            </span>
          </div>
          <div className="flex items-center gap-1">
            <span className="mr-1 text-[9px] uppercase tracking-[0.22em] text-muted-foreground/60">
              Speed
            </span>
            {SPEEDS.map((s) => (
              <button
                key={s.v}
                type="button"
                onClick={() => setSpeed(s.v)}
                className={cn(
                  "rounded-sm px-2 py-1 text-[10px] uppercase tracking-[0.18em] transition",
                  speed === s.v
                    ? "bg-secondary text-secondary-foreground"
                    : "text-muted-foreground hover:bg-secondary/40 hover:text-foreground",
                )}
                title={`${s.v} sim seconds / real second`}
              >
                {s.label}
              </button>
            ))}
            <div className="mx-1 h-4 w-px bg-border/40" />
            <button
              type="button"
              onClick={() => setTimelineOpen(!timelineOpen)}
              className="flex h-7 items-center gap-1 rounded-sm border border-border/40 px-2 text-[10px] uppercase tracking-[0.18em] text-muted-foreground transition hover:bg-secondary/40 hover:text-foreground"
              aria-expanded={timelineOpen}
            >
              Timeline{" "}
              {timelineOpen ? (
                <CaretDown size={11} />
              ) : (
                <CaretUp size={11} />
              )}
            </button>
          </div>
        </div>
      </footer>
    </>
  )
}

function BeatTimeline({
  plan,
  dayStartMs,
  dayLen,
  offsetMs,
  activeIdx,
  onScrub,
}: {
  plan: Plan
  dayStartMs: number
  dayLen: number
  offsetMs: number
  activeIdx: number
  onScrub: (ms: number) => void
}) {
  const wrapRef = useRef<HTMLDivElement>(null)
  const [w, setW] = useState(800)
  useEffect(() => {
    const el = wrapRef.current
    if (!el) return
    const update = () => setW(el.clientWidth)
    update()
    const ro = new ResizeObserver(update)
    ro.observe(el)
    return () => ro.disconnect()
  }, [])

  const handleClick = (e: React.MouseEvent<HTMLDivElement>) => {
    const r = e.currentTarget.getBoundingClientRect()
    const x = e.clientX - r.left
    const frac = Math.max(0, Math.min(1, x / r.width))
    onScrub(frac * dayLen)
  }

  // Hour ticks
  const ticks: { x: number; label: string }[] = []
  const firstHour =
    Math.ceil(dayStartMs / 3_600_000) * 3_600_000
  for (let t = firstHour; t <= dayStartMs + dayLen; t += 3_600_000) {
    const x = ((t - dayStartMs) / dayLen) * w
    const d = new Date(t)
    ticks.push({
      x,
      label: d.toLocaleTimeString("en-US", {
        hour: "numeric",
        hour12: false,
        timeZone: "America/Los_Angeles",
      }),
    })
  }

  return (
    <div
      ref={wrapRef}
      className="relative h-40 w-full overflow-hidden rounded-md border border-border/60 bg-[#0a0a0c]/70"
    >
      {/* Hour ticks */}
      <div className="absolute inset-x-0 top-0 h-6 border-b border-border/40">
        {ticks.map((t, i) => (
          <div
            key={i}
            className="absolute top-0 flex h-6 -translate-x-1/2 items-center justify-center font-mono text-[10px] uppercase tracking-[0.18em] text-muted-foreground"
            style={{ left: t.x }}
          >
            {t.label}
          </div>
        ))}
      </div>

      {/* Travel band (small narrow track above beats) */}
      <div
        className="absolute inset-x-0 top-6 h-4 cursor-pointer"
        onClick={handleClick}
      >
        {plan.beats.map((b, i) => {
          if (!b.travel_from_prev) return null
          const prev = plan.beats[i - 1]
          if (!prev) return null
          const tStart = new Date(prev.end_time).getTime() - dayStartMs
          const tEnd = new Date(b.start_time).getTime() - dayStartMs
          const x = (tStart / dayLen) * w
          const ww = Math.max(2, ((tEnd - tStart) / dayLen) * w)
          return (
            <div
              key={`t${i}`}
              className="absolute top-0 h-4 rounded-sm"
              style={{
                left: x,
                width: ww,
                backgroundColor:
                  b.travel_from_prev.mode === "walking"
                    ? "#22c55e66"
                    : b.travel_from_prev.mode === "driving"
                      ? "#fbbf2466"
                      : "#a855f766",
              }}
              title={`${b.travel_from_prev.mode} ${b.travel_from_prev.duration_minutes}m`}
            />
          )
        })}
      </div>

      {/* Beats track */}
      <div
        className="absolute inset-x-0 top-10 h-24 cursor-pointer"
        onClick={handleClick}
      >
        {plan.beats.map((b, i) => {
          const tStart = new Date(b.start_time).getTime() - dayStartMs
          const tEnd = new Date(b.end_time).getTime() - dayStartMs
          const x = (tStart / dayLen) * w
          const ww = Math.max(4, ((tEnd - tStart) / dayLen) * w)
          const color =
            ACTIVITY_COLORS[b.activity_type] ?? ACTIVITY_COLORS.other
          const active = i === activeIdx
          return (
            <div
              key={i}
              role="button"
              tabIndex={0}
              onClick={(e) => {
                e.stopPropagation()
                onScrub(tStart)
              }}
              className={cn(
                "absolute top-0 flex h-24 cursor-pointer flex-col justify-between overflow-hidden rounded-sm px-2 py-1.5 text-[10px] transition",
                active && "ring-2 ring-amber-400/80",
              )}
              style={{
                left: x,
                width: ww,
                backgroundColor: color + (active ? "" : "cc"),
              }}
              title={`${b.index + 1}. ${b.activity_type} — ${b.location_name}\n${fmtTime(b.start_time)}–${fmtTime(b.end_time)} (${durMin(b)}m)\n${b.activity}`}
            >
              <div className="flex flex-col gap-0.5 overflow-hidden">
                <span className="truncate font-mono text-[10px] font-semibold text-zinc-900">
                  {b.index + 1}. {b.location_name}
                </span>
                <span className="truncate font-mono text-[9px] uppercase tracking-[0.12em] text-zinc-900/80">
                  {b.activity_type}
                </span>
                <span className="truncate font-mono text-[9px] tabular-nums text-zinc-900/70">
                  {fmtTime(b.start_time)}
                </span>
              </div>
              <span className="line-clamp-2 text-[9px] leading-tight text-zinc-900/85">
                {b.activity}
              </span>
            </div>
          )
        })}
      </div>

      {/* Hour gridlines (subtle) */}
      <div
        className="pointer-events-none absolute inset-x-0 top-10 h-24"
        aria-hidden
      >
        {ticks.map((t, i) => (
          <div
            key={i}
            className="absolute top-0 h-24 w-px"
            style={{ left: t.x, backgroundColor: "rgba(255,255,255,0.05)" }}
          />
        ))}
      </div>

      {/* Current-time marker */}
      <div
        className="pointer-events-none absolute top-6 h-28 w-px bg-amber-400 shadow-[0_0_8px_0_rgb(245,158,11)]"
        style={{ left: (offsetMs / dayLen) * w }}
      >
        <div className="absolute -left-1.5 top-0 size-3 rounded-full bg-amber-400 shadow-[0_0_8px_0_rgb(245,158,11)]" />
      </div>

      {/* Scrub bar at bottom */}
      <div
        className="absolute inset-x-0 bottom-0 h-6 cursor-pointer border-t border-border/40"
        onClick={handleClick}
      >
        <div
          className="absolute top-0 h-6 bg-amber-500/15"
          style={{ width: `${(offsetMs / dayLen) * 100}%` }}
        />
        <div className="absolute inset-x-0 top-0 flex h-6 items-center justify-between px-2 font-mono text-[10px] uppercase tracking-[0.18em] text-muted-foreground">
          <span>{fmtClockFromOffset(0, dayStartMs)}</span>
          <span className="text-foreground">
            {fmtClockFromOffset(offsetMs, dayStartMs)}
          </span>
          <span>{fmtClockFromOffset(dayLen, dayStartMs)}</span>
        </div>
      </div>
    </div>
  )
}

function Section({
  title,
  children,
  defaultOpen,
}: {
  title: string
  children: React.ReactNode
  defaultOpen?: boolean
}) {
  const [open, setOpen] = useState(!!defaultOpen)
  return (
    <div className="border-b border-border/40 last:border-b-0">
      <button
        type="button"
        onClick={() => setOpen((o) => !o)}
        className="flex w-full items-center justify-between gap-2 px-3 py-2 text-[10px] uppercase tracking-[0.2em] text-muted-foreground transition hover:text-foreground"
      >
        <span>{title}</span>
        <CaretDown
          size={10}
          className={cn("transition", open ? "" : "-rotate-90")}
        />
      </button>
      {open && <div>{children}</div>}
    </div>
  )
}

function BeatRow({
  beat,
  active,
  onClick,
}: {
  beat: Beat
  active: boolean
  onClick: () => void
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      className={cn(
        "mb-1 block w-full rounded-sm border px-2.5 py-1.5 text-left text-[11px] transition",
        active
          ? "border-amber-400/60 bg-amber-500/10 text-foreground"
          : "border-transparent text-foreground/85 hover:border-border/60 hover:bg-secondary/30",
      )}
    >
      <div className="flex items-center justify-between gap-2">
        <div className="flex items-center gap-1.5">
          <span
            className="inline-block size-2 rounded-full"
            style={{
              backgroundColor:
                ACTIVITY_COLORS[beat.activity_type] ?? ACTIVITY_COLORS.other,
            }}
          />
          <span className="font-mono text-[10px] tabular-nums text-muted-foreground">
            {fmtTime(beat.start_time)}–{fmtTime(beat.end_time)}
          </span>
          <span className="text-[10px] text-muted-foreground/70">
            · {durMin(beat)}m
          </span>
        </div>
        {beat.travel_from_prev && (
          <span className="rounded-sm bg-secondary/60 px-1.5 py-0.5 text-[9px] uppercase tracking-[0.12em] text-muted-foreground">
            {beat.travel_from_prev.mode} {beat.travel_from_prev.duration_minutes}
            m
          </span>
        )}
      </div>
      <div className="mt-0.5">{beat.activity}</div>
      <div className="text-[10px] text-muted-foreground">
        @ {beat.location_name}
      </div>
    </button>
  )
}

function RailToggle({
  label,
  active,
  onClick,
  Icon,
}: {
  label: string
  active: boolean
  onClick: () => void
  Icon: PhosphorIcon
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      aria-pressed={active}
      className={cn(
        "flex items-center justify-center gap-1.5 rounded-sm px-2 py-1.5 text-[10px] uppercase tracking-[0.18em] transition",
        active
          ? "bg-amber-500/15 text-amber-100"
          : "text-muted-foreground hover:bg-secondary/40 hover:text-foreground",
      )}
    >
      <Icon size={11} weight={active ? "fill" : "regular"} />
      {label}
    </button>
  )
}

// --- Map helpers ----------------------------------------------------------

function installLayers(map: mapboxgl.Map, plan: Plan) {
  if (!map || !map.getContainer || !map.getContainer()) return
  const features = plan.beats
    .filter((b) => b.travel_from_prev)
    .map((b) => ({
      type: "Feature" as const,
      properties: { mode: b.travel_from_prev!.mode, beatIdx: b.index },
      geometry: {
        type: "LineString" as const,
        coordinates: b.travel_from_prev!.polyline,
      },
    }))
  const fc: GeoJSON.FeatureCollection = { type: "FeatureCollection", features }

  const routesSrc = map.getSource("routes") as
    | mapboxgl.GeoJSONSource
    | undefined
  if (routesSrc) {
    routesSrc.setData(fc)
  } else {
    map.addSource("routes", { type: "geojson", data: fc })
    // Dashed line per planned-but-not-yet-traversed segment. The traveled
    // portion shows up on top via the gradient `trail-line` layer.
    map.addLayer({
      id: "routes-line",
      type: "line",
      source: "routes",
      layout: { "line-cap": "round", "line-join": "round" },
      paint: {
        "line-color": [
          "match",
          ["get", "mode"],
          "walking",
          "#22c55e",
          "driving",
          "#fbbf24",
          "cycling",
          "#a855f7",
          "#94a3b8",
        ],
        "line-width": 2,
        "line-opacity": 0.4,
        "line-dasharray": [2, 2.5],
      },
    })
  }

  if (!map.getSource("cursor")) {
    // Breadcrumb trail of where the agent has actually traveled today.
    // `lineMetrics: true` lets us use `line-gradient` to fade the tail out.
    map.addSource("trail", {
      type: "geojson",
      lineMetrics: true,
      data: { type: "FeatureCollection", features: [] },
    })
    map.addLayer({
      id: "trail-line",
      type: "line",
      source: "trail",
      layout: { "line-cap": "round", "line-join": "round" },
      paint: {
        "line-width": [
          "interpolate",
          ["linear"],
          ["zoom"],
          11,
          1.5,
          16,
          3,
          20,
          5,
        ],
        "line-gradient": [
          "interpolate",
          ["linear"],
          ["line-progress"],
          0,
          "rgba(245, 158, 11, 0)",
          0.35,
          "rgba(245, 158, 11, 0.35)",
          1,
          "rgba(245, 158, 11, 1)",
        ],
      },
    })

    map.addSource("cursor", {
      type: "geojson",
      data: { type: "FeatureCollection", features: [] },
    })
    map.addLayer({
      id: "cursor-pulse",
      type: "circle",
      source: "cursor",
      paint: {
        "circle-radius": [
          "interpolate",
          ["linear"],
          ["zoom"],
          12,
          14,
          17,
          24,
          21,
          40,
        ],
        "circle-color": "#f59e0b",
        "circle-opacity": 0.2,
        "circle-blur": 0.8,
      },
    })
    map.addLayer({
      id: "cursor-dot",
      type: "circle",
      source: "cursor",
      paint: {
        "circle-radius": [
          "interpolate",
          ["linear"],
          ["zoom"],
          12,
          6,
          17,
          11,
          21,
          18,
        ],
        "circle-color": "#fbbf24",
        "circle-stroke-color": "#1c1917",
        "circle-stroke-width": 2,
      },
    })
  }
}

function installMarkers(
  map: mapboxgl.Map,
  plan: Plan,
  ref: React.MutableRefObject<mapboxgl.Marker[]>,
  onClick: (idx: number) => void,
) {
  if (!map || !map.getContainer || !map.getContainer()) return
  for (const m of ref.current) {
    try {
      m.remove()
    } catch {
      // ignore
    }
  }
  ref.current = []
  plan.beats.forEach((beat) => {
    const color =
      ACTIVITY_COLORS[beat.activity_type] ?? ACTIVITY_COLORS.other
    const el = document.createElement("div")
    el.className =
      "flex h-5 w-5 cursor-pointer items-center justify-center rounded-full border-2 text-[10px] font-bold text-zinc-950 transition-transform hover:scale-110"
    el.style.backgroundColor = color
    el.style.borderColor = "#0a0a0d"
    el.style.boxShadow = `0 0 0 1px ${color}66, 0 0 8px 0 ${color}55`
    el.textContent = String(beat.index + 1)
    el.title = `${beat.index + 1}. ${beat.activity_type} — ${beat.location_name}`
    el.addEventListener("click", (e) => {
      e.stopPropagation()
      onClick(beat.index)
    })
    try {
      const marker = new mapboxgl.Marker({ element: el })
        .setLngLat(beat.location)
        .addTo(map)
      ref.current.push(marker)
    } catch {
      // map was torn down between guard and addTo — ignore
    }
  })
}

function fitToPlan(map: mapboxgl.Map, plan: Plan) {
  const coords: LngLat[] = []
  for (const b of plan.beats) {
    coords.push(b.location)
    if (b.travel_from_prev) coords.push(...b.travel_from_prev.polyline)
  }
  if (coords.length < 2) return
  const bounds = coords.reduce(
    (acc, c) => acc.extend(c),
    new mapboxgl.LngLatBounds(coords[0], coords[0]),
  )
  map.fitBounds(bounds, { padding: 120, duration: 300 })
}

function enable3D(map: mapboxgl.Map) {
  map.easeTo({ pitch: 55, bearing: 0 })
  map.once("idle", () => {
    if (map.getLayer("3d-buildings")) return
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
  })
}

function disable3D(map: mapboxgl.Map) {
  map.easeTo({ pitch: 0, bearing: 0 })
  if (map.getLayer("3d-buildings")) map.removeLayer("3d-buildings")
}

function interpolateAlong(
  polyline: LngLat[],
  frac: number,
  fallbackFrom: LngLat,
  fallbackTo: LngLat,
): LngLat {
  if (!polyline || polyline.length < 2) {
    return lerpLngLat(fallbackFrom, fallbackTo, frac)
  }
  const segs: number[] = []
  let total = 0
  for (let i = 1; i < polyline.length; i++) {
    const d = haversine(polyline[i - 1], polyline[i])
    total += d
    segs.push(total)
  }
  if (total === 0) return polyline[polyline.length - 1]
  const target = frac * total
  for (let i = 0; i < segs.length; i++) {
    if (segs[i] >= target) {
      const segStart = i === 0 ? 0 : segs[i - 1]
      const segLen = segs[i] - segStart
      const segFrac = segLen > 0 ? (target - segStart) / segLen : 0
      return lerpLngLat(polyline[i], polyline[i + 1], segFrac)
    }
  }
  return polyline[polyline.length - 1]
}

function lerpLngLat(a: LngLat, b: LngLat, t: number): LngLat {
  return [a[0] + (b[0] - a[0]) * t, a[1] + (b[1] - a[1]) * t]
}

function haversine(a: LngLat, b: LngLat): number {
  const toRad = (d: number) => (d * Math.PI) / 180
  const R = 6371000
  const dLat = toRad(b[1] - a[1])
  const dLon = toRad(b[0] - a[0])
  const lat1 = toRad(a[1])
  const lat2 = toRad(b[1])
  const x =
    Math.sin(dLat / 2) ** 2 +
    Math.sin(dLon / 2) ** 2 * Math.cos(lat1) * Math.cos(lat2)
  return 2 * R * Math.asin(Math.sqrt(x))
}

// Slice a polyline at a normalized fraction along its length, returning the
// initial portion [start ... fractional_point]. Used to draw the trail as
// the agent moves through a transit segment.
function polylineUpToFrac(poly: LngLat[], frac: number): LngLat[] {
  if (poly.length < 2 || frac <= 0) return []
  if (frac >= 1) return poly.slice()
  const segs: number[] = []
  let total = 0
  for (let i = 1; i < poly.length; i++) {
    total += haversine(poly[i - 1], poly[i])
    segs.push(total)
  }
  if (total === 0) return [poly[0]]
  const target = frac * total
  const out: LngLat[] = [poly[0]]
  for (let i = 0; i < segs.length; i++) {
    if (segs[i] >= target) {
      const segStart = i === 0 ? 0 : segs[i - 1]
      const segLen = segs[i] - segStart
      const f = segLen > 0 ? (target - segStart) / segLen : 0
      out.push(lerpLngLat(poly[i], poly[i + 1], f))
      return out
    }
    out.push(poly[i + 1])
  }
  return out
}

// Build the breadcrumb LineString of the path the agent has actually
// traversed by `offsetMs`. Concatenates fully-completed travel polylines
// plus the partial polyline currently being traversed.
function computeTrail(
  plan: Plan,
  dayStartMs: number,
  offsetMs: number,
): LngLat[] {
  const tNow = dayStartMs + offsetMs
  const out: LngLat[] = []
  for (let i = 1; i < plan.beats.length; i++) {
    const b = plan.beats[i]
    if (!b.travel_from_prev) continue
    const prev = plan.beats[i - 1]
    const startMs = new Date(prev.end_time).getTime()
    const endMs = new Date(b.start_time).getTime()
    if (tNow <= startMs) break
    const poly = b.travel_from_prev.polyline
    if (poly.length === 0) continue
    if (tNow >= endMs) {
      // Avoid duplicating the join point between consecutive segments.
      if (out.length > 0 && out[out.length - 1][0] === poly[0][0] &&
          out[out.length - 1][1] === poly[0][1]) {
        out.push(...poly.slice(1))
      } else {
        out.push(...poly)
      }
    } else {
      const frac = (tNow - startMs) / Math.max(1, endMs - startMs)
      const partial = polylineUpToFrac(poly, frac)
      if (out.length > 0 && partial.length > 0 &&
          out[out.length - 1][0] === partial[0][0] &&
          out[out.length - 1][1] === partial[0][1]) {
        out.push(...partial.slice(1))
      } else {
        out.push(...partial)
      }
      break
    }
  }
  return out
}

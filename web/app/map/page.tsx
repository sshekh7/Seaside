"use client"

import { useCallback, useEffect, useMemo, useRef, useState } from "react"
import dynamic from "next/dynamic"
import mapboxgl from "mapbox-gl"
import "mapbox-gl/dist/mapbox-gl.css"
import { genConfig } from "react-nice-avatar"
import type { NiceAvatarProps } from "react-nice-avatar"
import type { Icon as PhosphorIcon } from "@phosphor-icons/react"
import {
  ArrowsCounterClockwise,
  CaretDown,
  CaretLeft,
  CaretRight,
  CaretUp,
  Cloud,
  CloudFog,
  CloudLightning,
  CloudRain,
  CloudSnow,
  CloudSun,
  Crosshair,
  Cube,
  Fire,
  MagnifyingGlass,
  Pause,
  Play,
  Snowflake,
  Sun,
  WaveSine,
  Wind,
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

const PULSE_COLOR = "#f59e0b" // amber: citywide movement
const AGENT_BACKDROP_COLOR = "#52525b" // zinc: dimmed population reference

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
  status?: string
  beats: Beat[]
  diary?: string
  thought_process?: string
  end_state?: { location: LngLat; energy: number; notes: string }
  world_event_prompt?: string
  generated_at?: string
  stats?: Record<string, number | boolean>
}

type PlanFile = { file: string; data: Plan }

type Day = {
  sim_date: string
  day_number: number
  plans: Plan[]
}

// Enrichment pulled from Supabase (keyed by agent id) for the profile card.
type AgentMeta = {
  config: Record<string, unknown>
  personality?: string
  job_description?: string
  age?: number | null
  location_home?: string
  location_work?: string
}

// One sampled tick of city activity across the day. `total` is the summed
// per-agent displacement (meters) since the previous sample; `perAgent`
// keeps each agent's own displacement so a selected agent can be overlaid.
type TimelineFrame = {
  t: number // sim offset (ms) at this sample
  total: number
  perAgent: Record<string, number>
}

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

const AGENT_PALETTE = [
  "#ff5577",
  "#7dd3fc",
  "#fb923c",
  "#34d399",
  "#c084fc",
  "#facc15",
  "#f472b6",
  "#a3e635",
  "#38bdf8",
  "#fca5a5",
  "#5eead4",
  "#fdba74",
]

// `v` = sim_seconds per real_second. v=900 means 15 sim min per real sec.
const SPEEDS: { label: string; v: number }[] = [
  { label: "5m/s", v: 300 },
  { label: "15m/s", v: 900 },
  { label: "30m/s", v: 1_800 },
  { label: "1h/s", v: 3_600 },
  { label: "3h/s", v: 10_800 },
]

function fmtClockFromOffset(offsetMs: number, baseMs: number): string {
  return new Date(baseMs + offsetMs).toLocaleTimeString("en-US", {
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
    hour12: false,
    timeZone: "America/Los_Angeles",
  })
}

function fmtTime(iso: string): string {
  return new Date(iso).toLocaleTimeString("en-US", {
    hour: "2-digit",
    minute: "2-digit",
    hour12: false,
    timeZone: "America/Los_Angeles",
  })
}

function fmtDate(sim_date: string): string {
  // Parse as a plain calendar date (avoid TZ shifting the day).
  const [y, m, d] = sim_date.split("-").map(Number)
  return new Date(y, m - 1, d).toLocaleDateString("en-US", {
    weekday: "short",
    month: "short",
    day: "numeric",
  })
}

// Stable color per agent across days.
function colorForAgent(id: string): string {
  let h = 0
  for (let i = 0; i < id.length; i++) h = (h * 31 + id.charCodeAt(i)) >>> 0
  return AGENT_PALETTE[h % AGENT_PALETTE.length]
}

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

// Derive a coarse weather chip from the day's world-event prompt.
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

type CursorResolved = {
  pos: LngLat
  activeIdx: number
  phase: "travel" | "stay"
}

// Resolve an agent's position at a given day offset. Agents that haven't
// "woken up" yet sit at their first beat; agents whose day has ended sit at
// their last beat. Reads no React state — safe to call from RAF.
function resolveCursor(
  plan: Plan,
  dayStartMs: number,
  offsetMs: number,
): CursorResolved {
  const beats = plan.beats
  if (beats.length === 0) {
    return { pos: SEATTLE_CENTER, activeIdx: 0, phase: "stay" }
  }
  const tNow = dayStartMs + offsetMs
  let activeIdx = 0
  for (let i = 0; i < beats.length; i++) {
    activeIdx = i
    if (new Date(beats[i].end_time).getTime() >= tNow) break
  }
  const beat = beats[activeIdx]
  const beatStart = new Date(beat.start_time).getTime()
  const prevBeat = activeIdx > 0 ? beats[activeIdx - 1] : null
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
  }
  return { pos, activeIdx, phase }
}

export default function MapPage() {
  const [days, setDays] = useState<Day[]>([])
  const [dayIdx, setDayIdx] = useState(0)
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)
  const [metaById, setMetaById] = useState<Record<string, AgentMeta>>({})

  useEffect(() => {
    fetch("/plans-bundle.json")
      .then((r) => r.json())
      .then((j: Plan[] | { plans: PlanFile[] }) => {
        const byDate = new Map<string, Day>()
        // Support both flat array (bundle) and legacy { plans: [{file,data}] }
        const items: Plan[] = Array.isArray(j)
          ? j
          : (j as { plans: PlanFile[] }).plans.map((p) => p.data)
        for (const data of items) {
          if (!data?.beats?.length) continue
          let day = byDate.get(data.sim_date)
          if (!day) {
            day = {
              sim_date: data.sim_date,
              day_number: data.day_number,
              plans: [],
            }
            byDate.set(data.sim_date, day)
          }
          day.plans.push(data)
        }
        const sorted = Array.from(byDate.values()).sort(
          (a, b) => a.day_number - b.day_number,
        )
        setDays(sorted)
      })
      .catch((e) => setError(String(e)))
      .finally(() => setLoading(false))
  }, [])

  // Best-effort enrichment from Supabase so the profile card can show the
  // agent's avatar, persona, job, and home/work. Matched by agent id; the
  // replay works fine without it.
  useEffect(() => {
    supabase
      .from("agents")
      .select("*")
      .then(({ data }) => {
        if (!data) return
        const map: Record<string, AgentMeta> = {}
        for (const row of data) {
          map[row.id] = {
            config: row.profile_pic || genConfig(),
            personality: row.personality ?? undefined,
            job_description: row.job_description ?? undefined,
            age: row.age ?? null,
            location_home: row.location_home ?? undefined,
            location_work: row.location_work ?? undefined,
          }
        }
        setMetaById(map)
      })
  }, [])

  if (loading) {
    return (
      <div className="flex h-svh items-center justify-center bg-background text-sm text-muted-foreground">
        loading world…
      </div>
    )
  }
  if (error || days.length === 0) {
    return (
      <div className="flex h-svh items-center justify-center bg-background text-sm text-muted-foreground">
        {error ?? "no plans found in experiments/output/plans/"}
      </div>
    )
  }

  return (
    <DayReplay
      days={days}
      dayIdx={dayIdx}
      setDayIdx={setDayIdx}
      metaById={metaById}
    />
  )
}

function DayReplay({
  days,
  dayIdx,
  setDayIdx,
  metaById,
}: {
  days: Day[]
  dayIdx: number
  setDayIdx: (i: number) => void
  metaById: Record<string, AgentMeta>
}) {
  const day = days[dayIdx]

  const containerRef = useRef<HTMLDivElement | null>(null)
  const mapRef = useRef<mapboxgl.Map | null>(null)
  const mapLoadedRef = useRef(false)

  const [style, setStyle] = useState<StyleKey>("Dark")
  const [is3D, setIs3D] = useState(false)
  const [heatmap, setHeatmap] = useState(false)
  const [offsetMs, setOffsetMs] = useState(0)
  const [playing, setPlaying] = useState(false)
  const [speed, setSpeed] = useState(900)
  const [selectedId, setSelectedId] = useState<string | null>(null)
  const [following, setFollowing] = useState(false)
  const [autoplay, setAutoplay] = useState(true)
  const [timelineOpen, setTimelineOpen] = useState(false)
  const [eventOpen, setEventOpen] = useState(false)

  // Find-an-agent search box (top bar).
  const [searchOpen, setSearchOpen] = useState(false)
  const [query, setQuery] = useState("")
  const [activeMatch, setActiveMatch] = useState(0)
  const searchBoxRef = useRef<HTMLDivElement | null>(null)
  const searchInputRef = useRef<HTMLInputElement | null>(null)
  const worldEvent = day.plans[0]?.world_event_prompt ?? "—"
  const weather = useMemo(() => parseWeather(worldEvent), [worldEvent])

  // Day time bounds = the union of every agent's active window that day.
  const { dayStartMs, dayLen } = useMemo(() => {
    let min = Infinity
    let max = -Infinity
    for (const plan of day.plans) {
      const b = plan.beats
      if (b.length === 0) continue
      min = Math.min(min, new Date(b[0].start_time).getTime())
      max = Math.max(max, new Date(b[b.length - 1].end_time).getTime())
    }
    if (!isFinite(min)) min = max = Date.now()
    return { dayStartMs: min, dayLen: Math.max(1, max - min) }
  }, [day])

  // Deterministic city-activity profile for the whole day: sample every
  // agent's position across N buckets and record per-bucket displacement.
  // Drives the bottom graph (city movement + selected-agent overlay) and a
  // playhead that tracks the current sim offset. Recomputed only per day.
  const frames = useMemo(() => {
    const BUCKETS = 200
    const out: TimelineFrame[] = []
    let prevPos: Record<string, LngLat> = {}
    for (let i = 0; i <= BUCKETS; i++) {
      const off = (dayLen * i) / BUCKETS
      const frame: TimelineFrame = { t: off, total: 0, perAgent: {} }
      const nextPrev: Record<string, LngLat> = {}
      for (const plan of day.plans) {
        const { pos } = resolveCursor(plan, dayStartMs, off)
        nextPrev[plan.agent_id] = pos
        const old = prevPos[plan.agent_id]
        const d = old ? haversine(old, pos) : 0
        frame.perAgent[plan.agent_id] = d
        frame.total += d
      }
      prevPos = nextPrev
      out.push(frame)
    }
    return out
  }, [day, dayStartMs, dayLen])

  const playingRef = useRef(playing)
  const speedRef = useRef(speed)
  const offsetRef = useRef(offsetMs)
  const followingRef = useRef(following)
  const selectedRef = useRef(selectedId)
  const dayRef = useRef(day)
  const dayStartRef = useRef(dayStartMs)
  const bearingRef = useRef(0)
  playingRef.current = playing
  speedRef.current = speed
  offsetRef.current = offsetMs
  followingRef.current = following
  selectedRef.current = selectedId
  dayRef.current = day
  dayStartRef.current = dayStartMs
  const heatmapRef = useRef(heatmap)
  heatmapRef.current = heatmap
  const autoplayRef = useRef(autoplay)
  autoplayRef.current = autoplay
  const dayIdxRef = useRef(dayIdx)
  dayIdxRef.current = dayIdx

  // DEMO: swarm target polling
  const swarmTargetRef = useRef<{ lng: number; lat: number; label: string; timeHour?: number; agentCount?: number } | null>(null)
  const swarmStartRef = useRef(0)
  useEffect(() => {
    const poll = setInterval(async () => {
      try {
        const res = await fetch("/api/swarm")
        const { target } = await res.json()
        if (target && !swarmTargetRef.current) {
          swarmStartRef.current = Date.now()
        }
        swarmTargetRef.current = target
      } catch { /* ignore */ }
    }, 2000)
    return () => clearInterval(poll)
  }, [])
  const daysLenRef = useRef(days.length)
  daysLenRef.current = days.length
  const selectedPlan = selectedId
    ? (day.plans.find((p) => p.agent_id === selectedId) ?? null)
    : null
  const selectedMeta = selectedId ? metaById[selectedId] : undefined

  // Lightweight selected-agent live info for the side card.
  const [selInfo, setSelInfo] = useState<{
    idx: number
    phase: "travel" | "stay"
  } | null>(null)
  const selInfoRef = useRef<{ idx: number; phase: "travel" | "stay" } | null>(
    null,
  )

  // Decaying buffer of recent agent positions for the heatmap trail effect.
  // Each entry's weight fades every sample tick, leaving comet-like trails.
  const trailRef = useRef<{ lng: number; lat: number; w: number }[]>([])
  const lastTrailRef = useRef(0)

  // Draggable position for the Unit Profile card. Null = default anchored
  // position (bottom-left). Once dragged it switches to a free top-left offset.
  const [cardPos, setCardPos] = useState<{ x: number; y: number } | null>(null)
  const dragRef = useRef<{
    startX: number
    startY: number
    originX: number
    originY: number
  } | null>(null)

  // Reset the card position whenever a different agent is selected.
  useEffect(() => {
    setCardPos(null)
  }, [selectedId])

  const onCardDragStart = (e: React.PointerEvent<HTMLDivElement>) => {
    // Ignore drags that start on the action buttons.
    if ((e.target as HTMLElement).closest("button")) return
    const card = e.currentTarget.parentElement
    if (!card) return
    const rect = card.getBoundingClientRect()
    const parentRect = card.parentElement?.getBoundingClientRect()
    if (!parentRect) return
    dragRef.current = {
      startX: e.clientX,
      startY: e.clientY,
      originX: rect.left - parentRect.left,
      originY: rect.top - parentRect.top,
    }
    e.currentTarget.setPointerCapture(e.pointerId)
  }

  const onCardDragMove = (e: React.PointerEvent<HTMLDivElement>) => {
    const d = dragRef.current
    if (!d) return
    const card = e.currentTarget.parentElement
    const parent = card?.parentElement
    if (!card || !parent) return
    const pr = parent.getBoundingClientRect()
    const cr = card.getBoundingClientRect()
    const nx = d.originX + (e.clientX - d.startX)
    const ny = d.originY + (e.clientY - d.startY)
    const maxX = pr.width - cr.width
    const maxY = pr.height - cr.height
    setCardPos({
      x: Math.max(0, Math.min(maxX, nx)),
      y: Math.max(0, Math.min(maxY, ny)),
    })
  }

  const onCardDragEnd = (e: React.PointerEvent<HTMLDivElement>) => {
    dragRef.current = null
    if (e.currentTarget.hasPointerCapture(e.pointerId)) {
      e.currentTarget.releasePointerCapture(e.pointerId)
    }
  }

  // Init map once.
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

    map.on("load", () => {
      mapLoadedRef.current = true
      installLayers(map)
      fitToDay(map, dayRef.current)

      map.on("click", "agents-dot", (e) => {
        const id = e.features?.[0]?.properties?.id as string | undefined
        if (id) {
          setSelectedId(id)
          followingRef.current = true
          setFollowing(true)
          setIs3D(true)
        }
      })
      map.on("mouseenter", "agents-dot", () => {
        map.getCanvas().style.cursor = "pointer"
      })
      map.on("mouseleave", "agents-dot", () => {
        map.getCanvas().style.cursor = ""
      })
      map.on("dragstart", () => {
        if (followingRef.current) {
          followingRef.current = false
          setFollowing(false)
        }
      })
      map.on("wheel", () => {
        if (followingRef.current) {
          followingRef.current = false
          setFollowing(false)
        }
      })
    })

    const ro = new ResizeObserver(() => {
      try {
        map.resize()
      } catch {
        /* ignore */
      }
    })
    ro.observe(containerRef.current)

    return () => {
      ro.disconnect()
      mapLoadedRef.current = false
      try {
        map.remove()
      } catch {
        /* ignore */
      }
      mapRef.current = null
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  // Style swap — reinstall layers after the new style loads.
  useEffect(() => {
    const map = mapRef.current
    if (!map || !mapLoadedRef.current) return
    map.setStyle(STYLES[style])
    map.once("style.load", () => {
      installLayers(map)
      if (is3D) enable3D(map)
      if (heatmapRef.current) applyHeatmap(map, true)
    })
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [style])

  // 3D toggle.
  useEffect(() => {
    const map = mapRef.current
    if (!map || !mapLoadedRef.current) return
    if (is3D) enable3D(map)
    else disable3D(map)
  }, [is3D])

  // Heatmap toggle — swap the per-agent dots for a citywide density layer.
  useEffect(() => {
    const map = mapRef.current
    if (!map || !mapLoadedRef.current) return
    applyHeatmap(map, heatmap)
    if (!heatmap) {
      // Reset the trail buffer so re-enabling starts fresh.
      trailRef.current = []
      const heatSrc = map.getSource("heat-src") as
        | mapboxgl.GeoJSONSource
        | undefined
      heatSrc?.setData({ type: "FeatureCollection", features: [] })
    }
  }, [heatmap])

  // Day change — reset clock, refit. Playback state is intentionally left
  // untouched: an auto-advance at the end of a day keeps `playing` true so the
  // next day rolls straight on, while manual day navigation pauses explicitly
  // via `goToDay` before the day changes.
  useEffect(() => {
    setOffsetMs(0)
    offsetRef.current = 0
    const map = mapRef.current
    if (map && mapLoadedRef.current) fitToDay(map, day)
  }, [day])

  // Selected-agent route highlight.
  useEffect(() => {
    const map = mapRef.current
    if (!map || !mapLoadedRef.current) return
    const routeSrc = map.getSource("sel-route") as
      | mapboxgl.GeoJSONSource
      | undefined
    if (!routeSrc) return
    if (!selectedPlan) {
      routeSrc.setData({ type: "FeatureCollection", features: [] })
      return
    }
    const features = selectedPlan.beats
      .filter((b) => b.travel_from_prev)
      .map((b) => ({
        type: "Feature" as const,
        properties: { mode: b.travel_from_prev!.mode },
        geometry: {
          type: "LineString" as const,
          coordinates: b.travel_from_prev!.polyline,
        },
      }))
    routeSrc.setData({ type: "FeatureCollection", features })
  }, [selectedPlan])

  // Single RAF loop: advance the clock and write every agent's position into
  // the shared GeoJSON source. No per-frame React churn except the clock.
  useEffect(() => {
    let raf = 0
    let last = performance.now()
    let lastCamMs = 0
    const CAM_INTERVAL = 80
    const tick = (now: number) => {
      const dt = now - last
      last = now
      if (playingRef.current) {
        const next = offsetRef.current + dt * speedRef.current
        if (next >= dayLen) {
          // Day's over. Auto-advance to the next day if there is one and
          // continuous playback is on; otherwise stop at the end. `playing`
          // stays true through the advance so the next day rolls straight on.
          if (
            autoplayRef.current &&
            dayIdxRef.current < daysLenRef.current - 1
          ) {
            offsetRef.current = dayLen
            setOffsetMs(dayLen)
            setDayIdx(dayIdxRef.current + 1)
          } else {
            offsetRef.current = dayLen
            setOffsetMs(dayLen)
            setPlaying(false)
          }
        } else {
          offsetRef.current = next
          setOffsetMs(next)
        }
      }

      const map = mapRef.current
      if (map && mapLoadedRef.current) {
        const curDay = dayRef.current
        const start = dayStartRef.current
        const off = offsetRef.current
        const selId = selectedRef.current

        const features: GeoJSON.Feature[] = []
        let selCur: CursorResolved | null = null
        for (const plan of curDay.plans) {
          const cur = resolveCursor(plan, start, off)
          const selected = plan.agent_id === selId
          if (selected) selCur = cur
          features.push({
            type: "Feature",
            geometry: { type: "Point", coordinates: cur.pos },
            properties: {
              id: plan.agent_id,
              name: plan.agent_name,
              color: colorForAgent(plan.agent_id),
              selected,
              // Heatmap weight: agents in transit are "the action".
              weight: cur.phase === "travel" ? 1 : 0.3,
            },
          })
        }
        const src = map.getSource("agents-src") as
          | mapboxgl.GeoJSONSource
          | undefined
        if (src) {
          // DEMO: agents divert to event at the specified sim time
          const st = swarmTargetRef.current
          if (st && off > 0) {
            // Convert sim offset to hour of day
            const simHour = (start + off) / 3600000 % 24
            // Only activate within 1 hour before event time
            const eventHour = st.timeHour || 19
            const hoursUntil = eventHour - simHour
            if (hoursUntil <= 1 && hoursUntil >= -2) {
              // Progress: 0 at 1hr before, 1 at event time
              const progress = Math.min(Math.max((1 - hoursUntil) / 1, 0), 1)
              const maxAgents = st.agentCount || 50
              let affected = 0
              for (let fi = 0; fi < features.length && affected < maxAgents; fi++) {
                const f = features[fi]
                const name = (f.properties?.name || "") as string
                const hash = name.split("").reduce((a, c) => a + c.charCodeAt(0), 0)
                // Deterministic selection — pick specific agents
                if (hash % 3 !== 0) continue // ~33% base filter
                affected++
                // Stagger: each agent starts moving at different progress thresholds
                const threshold = (hash % 20) / 20 * 0.6 // 0-0.6
                if (progress < threshold) continue
                const agentProgress = Math.min((progress - threshold) / 0.4, 1)
                const coords = (f.geometry as GeoJSON.Point).coordinates
                const spread = 0.004 * (1 - agentProgress * 0.6)
                const ox = Math.sin(hash * 0.7) * spread
                const oy = Math.cos(hash * 1.3) * spread
                coords[0] = coords[0] + (st.lng + ox - coords[0]) * agentProgress
                coords[1] = coords[1] + (st.lat + oy - coords[1]) * agentProgress
              }
            }
          }
          src.setData({ type: "FeatureCollection", features })
        }

        // Heatmap trails: every ~80ms sample the current positions into a
        // decaying buffer and feed the dedicated heat source. Older samples
        // fade out, leaving a comet trail behind moving "action".
        if (heatmapRef.current && now - lastTrailRef.current >= 80) {
          lastTrailRef.current = now
          const buf = trailRef.current
          for (const p of buf) p.w *= 0.97
          for (const f of features) {
            const g = f.geometry as GeoJSON.Point
            const [lng, lat] = g.coordinates as [number, number]
            const w = (f.properties?.weight as number) ?? 0.3
            buf.push({ lng, lat, w })
          }
          // Drop faded points and cap the buffer for performance.
          const kept = buf.filter((p) => p.w > 0.03)
          if (kept.length > 16000) kept.splice(0, kept.length - 16000)
          trailRef.current = kept
          const heatSrc = map.getSource("heat-src") as
            | mapboxgl.GeoJSONSource
            | undefined
          if (heatSrc) {
            heatSrc.setData({
              type: "FeatureCollection",
              features: kept.map((p) => ({
                type: "Feature",
                geometry: { type: "Point", coordinates: [p.lng, p.lat] },
                properties: { weight: p.w },
              })),
            })
          }
        }

        // Selected-agent card: only re-render React on beat/phase change.
        if (selCur) {
          if (
            !selInfoRef.current ||
            selInfoRef.current.idx !== selCur.activeIdx ||
            selInfoRef.current.phase !== selCur.phase
          ) {
            selInfoRef.current = { idx: selCur.activeIdx, phase: selCur.phase }
            setSelInfo({ idx: selCur.activeIdx, phase: selCur.phase })
          }
        } else if (selInfoRef.current) {
          selInfoRef.current = null
          setSelInfo(null)
        }

        // Follow camera on the selected agent.
        if (
          followingRef.current &&
          selCur &&
          now - lastCamMs >= CAM_INTERVAL
        ) {
          lastCamMs = now
          const selPlan = curDay.plans.find((p) => p.agent_id === selId)
          if (selPlan) {
            const ahead = resolveCursor(
              selPlan,
              start,
              Math.min(dayLen, off + 1500),
            )
            const dx = ahead.pos[0] - selCur.pos[0]
            const dy = ahead.pos[1] - selCur.pos[1]
            const curBearing = map.getBearing()
            let bearing = curBearing
            if (dx * dx + dy * dy > 1e-12) {
              const desired = (Math.atan2(dx, dy) * 180) / Math.PI
              const delta = ((desired - curBearing + 540) % 360) - 180
              bearing = curBearing + delta * 0.18
              bearingRef.current = bearing
            }
            map.easeTo({
              center: selCur.pos,
              zoom: 16.5,
              pitch: 55,
              bearing,
              duration: 240,
              easing: (t) => t * (2 - t),
              essential: true,
            })
          }
        }
      }

      raf = requestAnimationFrame(tick)
    }
    raf = requestAnimationFrame(tick)
    return () => cancelAnimationFrame(raf)
  }, [dayLen])

  const toggle = useCallback(() => {
    if (offsetRef.current >= dayLen) setOffsetMs(0)
    setPlaying((p) => !p)
  }, [dayLen])

  const reset = useCallback(() => {
    setPlaying(false)
    setOffsetMs(0)
  }, [])

  // Manual day navigation pauses playback; auto-advance leaves it running.
  const goToDay = useCallback(
    (i: number) => {
      setPlaying(false)
      setDayIdx(Math.max(0, Math.min(daysLenRef.current - 1, i)))
    },
    [setDayIdx],
  )

  const recenter = useCallback(() => {
    const map = mapRef.current
    if (!map || !selectedPlan) return
    followingRef.current = true
    setFollowing(true)
    setIs3D(true)
    const cur = resolveCursor(selectedPlan, dayStartMs, offsetRef.current)
    map.flyTo({
      center: cur.pos,
      zoom: 16.5,
      pitch: 55,
      speed: 1.2,
      curve: 1.4,
      essential: true,
    })
  }, [selectedPlan, dayStartMs])

  // Select an agent by id (used by the find box): flag it, fly the camera to
  // its current position, and start following — mirrors clicking its dot.
  const selectAgent = useCallback((id: string) => {
    setSelectedId(id)
    followingRef.current = true
    setFollowing(true)
    setIs3D(true)
    const map = mapRef.current
    const plan = dayRef.current.plans.find((p) => p.agent_id === id)
    if (map && mapLoadedRef.current && plan) {
      const cur = resolveCursor(plan, dayStartRef.current, offsetRef.current)
      map.flyTo({
        center: cur.pos,
        zoom: 16.5,
        pitch: 55,
        speed: 1.2,
        curve: 1.4,
        essential: true,
      })
    }
    setSearchOpen(false)
    setQuery("")
  }, [])

  // Agents on the current day matching the search query (by name), ranked so
  // prefix matches come first. Capped to keep the dropdown small.
  const matches = useMemo(() => {
    const q = query.trim().toLowerCase()
    if (!q) return [] as Plan[]
    return day.plans
      .filter((p) => p.agent_name.toLowerCase().includes(q))
      .sort((a, b) => {
        const ap = a.agent_name.toLowerCase().startsWith(q) ? 0 : 1
        const bp = b.agent_name.toLowerCase().startsWith(q) ? 0 : 1
        if (ap !== bp) return ap - bp
        return a.agent_name.localeCompare(b.agent_name)
      })
      .slice(0, 8)
  }, [query, day])

  // Keep the highlighted row reset as the query changes.
  useEffect(() => {
    setActiveMatch(0)
  }, [query])

  // Close the find dropdown on outside click.
  useEffect(() => {
    if (!searchOpen) return
    const onDown = (e: MouseEvent) => {
      if (!searchBoxRef.current?.contains(e.target as Node)) {
        setSearchOpen(false)
      }
    }
    document.addEventListener("mousedown", onDown)
    return () => document.removeEventListener("mousedown", onDown)
  }, [searchOpen])

  const selBeat = selectedPlan && selInfo ? selectedPlan.beats[selInfo.idx] : null

  return (
    <div className="flex h-svh max-h-svh w-full flex-col overflow-hidden bg-background text-foreground">
      {/* TOP BAR */}
      <header className="flex h-10 shrink-0 items-center justify-between border-b border-border/40 bg-[#0a0a0d] px-3 text-[10px] uppercase tracking-[0.18em]">
        <div className="flex items-center gap-2">
          <span className="font-mono font-semibold text-foreground">
            SEASIDE
          </span>
          <span className="text-muted-foreground/40">//</span>
          <div className="flex items-center gap-1">
            <button
              type="button"
              onClick={() => goToDay(dayIdx - 1)}
              disabled={dayIdx === 0}
              className="flex h-6 w-6 items-center justify-center rounded-sm text-muted-foreground transition hover:bg-secondary/40 hover:text-foreground disabled:opacity-30"
              aria-label="Previous day"
            >
              <CaretLeft size={11} weight="bold" />
            </button>
            <select
              value={dayIdx}
              onChange={(e) => goToDay(Number(e.target.value))}
              className="h-6 rounded-sm border border-border/40 bg-[#08080b] px-2 font-mono text-[11px] normal-case tracking-normal text-foreground focus:border-amber-400/60 focus:outline-none"
            >
              {days.map((d, i) => (
                <option key={d.sim_date} value={i}>
                  Day {d.day_number} · {fmtDate(d.sim_date)} ({d.plans.length})
                </option>
              ))}
            </select>
            <button
              type="button"
              onClick={() => goToDay(dayIdx + 1)}
              disabled={dayIdx === days.length - 1}
              className="flex h-6 w-6 items-center justify-center rounded-sm text-muted-foreground transition hover:bg-secondary/40 hover:text-foreground disabled:opacity-30"
              aria-label="Next day"
            >
              <CaretRight size={11} weight="bold" />
            </button>
          </div>
          <button
            type="button"
            onClick={() => setAutoplay((a) => !a)}
            className={cn(
              "flex h-6 items-center gap-1 rounded-sm border px-2 text-[9px] uppercase tracking-[0.18em] transition",
              autoplay
                ? "border-amber-400/60 bg-amber-400/15 text-amber-300"
                : "border-border/40 text-muted-foreground hover:bg-secondary/40 hover:text-foreground",
            )}
            title="Continue into the next day when the current one ends"
            aria-pressed={autoplay}
          >
            <ArrowsCounterClockwise size={11} weight="bold" />
            Auto
          </button>
        </div>
        <div className="flex items-center gap-3">
          <div ref={searchBoxRef} className="relative">
            {searchOpen ? (
              <div className="relative">
                <MagnifyingGlass
                  size={12}
                  weight="bold"
                  className="pointer-events-none absolute left-2 top-1/2 -translate-y-1/2 text-muted-foreground/70"
                />
                <input
                  ref={searchInputRef}
                  type="text"
                  value={query}
                  onChange={(e) => setQuery(e.target.value)}
                  autoFocus
                  placeholder="Find agent…"
                  className="h-6 w-48 rounded-sm border border-border/40 bg-[#08080b] pl-6 pr-6 font-mono text-[11px] normal-case tracking-normal text-foreground placeholder:text-muted-foreground/50 focus:border-amber-400/60 focus:outline-none"
                  onKeyDown={(e) => {
                    if (e.key === "ArrowDown") {
                      e.preventDefault()
                      setActiveMatch((i) => Math.min(matches.length - 1, i + 1))
                    } else if (e.key === "ArrowUp") {
                      e.preventDefault()
                      setActiveMatch((i) => Math.max(0, i - 1))
                    } else if (e.key === "Enter") {
                      e.preventDefault()
                      const pick = matches[activeMatch]
                      if (pick) selectAgent(pick.agent_id)
                    } else if (e.key === "Escape") {
                      e.preventDefault()
                      setSearchOpen(false)
                      setQuery("")
                    }
                  }}
                />
                <button
                  type="button"
                  onClick={() => {
                    setSearchOpen(false)
                    setQuery("")
                  }}
                  className="absolute right-1.5 top-1/2 -translate-y-1/2 text-muted-foreground/70 transition hover:text-foreground"
                  aria-label="Close search"
                >
                  <X size={11} weight="bold" />
                </button>
                {query.trim() && (
                  <div className="absolute left-0 top-7 z-20 max-h-72 w-56 overflow-y-auto rounded-md border border-border/40 bg-[#0a0a0d]/95 py-1 shadow-lg backdrop-blur">
                    {matches.length === 0 ? (
                      <div className="px-2.5 py-1.5 text-[10px] normal-case tracking-normal text-muted-foreground/60">
                        No agents found
                      </div>
                    ) : (
                      matches.map((p, i) => (
                        <button
                          key={p.agent_id}
                          type="button"
                          onMouseEnter={() => setActiveMatch(i)}
                          onClick={() => selectAgent(p.agent_id)}
                          className={cn(
                            "flex w-full items-center gap-2 px-2.5 py-1.5 text-left transition",
                            i === activeMatch
                              ? "bg-secondary/60"
                              : "hover:bg-secondary/30",
                          )}
                        >
                          <span
                            className="size-2 shrink-0 rounded-full"
                            style={{
                              backgroundColor: colorForAgent(p.agent_id),
                            }}
                          />
                          <span className="truncate font-mono text-[11px] normal-case tracking-normal text-foreground">
                            {p.agent_name}
                          </span>
                        </button>
                      ))
                    )}
                  </div>
                )}
              </div>
            ) : (
              <button
                type="button"
                onClick={() => setSearchOpen(true)}
                className="flex h-6 items-center gap-1.5 rounded-sm border border-border/40 bg-[#08080b] px-2 text-[9px] uppercase tracking-[0.18em] text-muted-foreground transition hover:border-amber-400/40 hover:text-foreground"
                aria-label="Find agent"
              >
                <MagnifyingGlass size={11} weight="bold" />
                Find
              </button>
            )}
          </div>
          <span className="font-mono tabular-nums normal-case tracking-normal text-foreground/90">
            {fmtDate(day.sim_date)} · {fmtClockFromOffset(offsetMs, dayStartMs)}
          </span>
          <span className="text-muted-foreground/60">
            {day.plans.length} agents
          </span>
        </div>
      </header>

      {/* BODY */}
      <div className="relative flex min-h-0 flex-1 overflow-hidden">
        <div className="relative min-h-0 min-w-0 flex-1 overflow-hidden">
          <div ref={containerRef} className="absolute inset-0 h-full w-full" />

          {/* Time · weather · world-event accordion (top-left) */}
          <div className="absolute left-3 top-3 z-10 w-72 max-w-[calc(100%-1.5rem)] rounded-md border border-border/40 bg-[#0a0a0d]/85 backdrop-blur">
            <div className="px-3 py-2.5">
              {/* Date (weekday) */}
              <div className="mb-1 text-[10px] uppercase tracking-[0.18em] text-amber-400/80">
                {fmtDate(day.sim_date)}
              </div>
              {/* Time (large) */}
              <div className="font-mono text-2xl font-semibold tabular-nums leading-none tracking-tight text-foreground">
                {fmtClockFromOffset(offsetMs, dayStartMs)}
              </div>
              {/* Weather (smaller, below) */}
              <div className="mt-1.5 flex items-center gap-1.5 text-[11px] text-muted-foreground">
                {weather ? (
                  <>
                    <weather.Icon
                      size={14}
                      weight="fill"
                      className="text-amber-400/90"
                    />
                    <span className="normal-case text-foreground/80">
                      {weather.label}
                    </span>
                    {weather.tempF != null && (
                      <span className="font-mono tabular-nums text-muted-foreground/70">
                        {weather.tempF}°F
                      </span>
                    )}
                  </>
                ) : (
                  <span className="normal-case text-muted-foreground/60">
                    {fmtDate(day.sim_date)}
                  </span>
                )}
              </div>
            </div>

            {/* World event — accordion, collapsed by default */}
            <div className="border-t border-border/40">
              <button
                type="button"
                onClick={() => setEventOpen((o) => !o)}
                className="flex w-full items-center justify-between px-3 py-2 text-left transition hover:bg-secondary/30"
              >
                <span className="text-[9px] uppercase tracking-[0.22em] text-muted-foreground/80">
                  World event · Day {day.day_number}
                </span>
                <CaretDown
                  size={11}
                  weight="bold"
                  className={cn(
                    "text-muted-foreground/70 transition-transform",
                    eventOpen && "rotate-180",
                  )}
                />
              </button>
              {eventOpen && (
                <div className="px-3 pb-2.5 text-[10px] normal-case leading-snug text-foreground/90 animate-in fade-in slide-in-from-top-1 duration-150">
                  {worldEvent}
                </div>
              )}
            </div>
          </div>

          {/* Layer / style toggles */}
          <div className="absolute right-3 top-3 z-10 flex flex-col items-end gap-1.5">
            <div className="flex gap-1 rounded-md border border-border/40 bg-[#0a0a0d]/85 p-1 backdrop-blur">
              {(Object.keys(STYLES) as StyleKey[]).map((s) => (
                <button
                  key={s}
                  type="button"
                  onClick={() => setStyle(s)}
                  className={cn(
                    "rounded-sm px-2 py-1 text-[9px] uppercase tracking-[0.18em] transition",
                    style === s
                      ? "bg-secondary text-secondary-foreground"
                      : "text-muted-foreground hover:bg-secondary/40 hover:text-foreground",
                  )}
                >
                  {s}
                </button>
              ))}
            </div>
            <div className="flex gap-1 rounded-md border border-border/40 bg-[#0a0a0d]/85 p-1 backdrop-blur">
              <ToggleBtn
                label="3D"
                active={is3D}
                onClick={() => setIs3D(!is3D)}
                Icon={Cube}
              />
              <ToggleBtn
                label="Heat"
                active={heatmap}
                onClick={() => setHeatmap(!heatmap)}
                Icon={Fire}
              />
              <ToggleBtn
                label="Follow"
                active={following}
                onClick={recenter}
                disabled={!selectedPlan}
                Icon={Crosshair}
              />
            </div>
          </div>

          {/* Selected agent profile — avatar, persona, live activity, and
              the agent's timeline for the day so far. */}
          {selectedPlan && (
            <div
              className={cn(
                "absolute z-10 flex max-h-[calc(100%-1.5rem)] w-72 flex-col overflow-hidden rounded-md border border-border/60 bg-card/95 backdrop-blur",
                cardPos
                  ? ""
                  : "bottom-3 right-3 animate-in fade-in slide-in-from-right-2 duration-200",
              )}
              style={
                cardPos ? { left: cardPos.x, top: cardPos.y } : undefined
              }
            >
              {/* Header (drag handle) */}
              <div
                onPointerDown={onCardDragStart}
                onPointerMove={onCardDragMove}
                onPointerUp={onCardDragEnd}
                onPointerCancel={onCardDragEnd}
                className="flex cursor-grab touch-none select-none items-center justify-between border-b border-border/60 px-3 py-2 active:cursor-grabbing"
              >
                <span className="text-[10px] uppercase tracking-[0.18em] text-foreground">
                  Unit Profile
                </span>
                <div className="flex items-center gap-1">
                  <button
                    type="button"
                    onClick={recenter}
                    className={cn(
                      "rounded-sm p-1 transition",
                      following
                        ? "text-amber-400 hover:bg-secondary/60"
                        : "text-muted-foreground hover:bg-secondary/60 hover:text-foreground",
                    )}
                    aria-label="Recenter on unit"
                    title="Recenter"
                  >
                    <Crosshair
                      size={12}
                      weight={following ? "fill" : "regular"}
                    />
                  </button>
                  <button
                    type="button"
                    onClick={() => {
                      setSelectedId(null)
                      followingRef.current = false
                      setFollowing(false)
                    }}
                    className="rounded-sm p-1 text-muted-foreground transition hover:bg-secondary/60 hover:text-foreground"
                    aria-label="Close profile"
                  >
                    <X size={12} />
                  </button>
                </div>
              </div>

              {/* Identity */}
              <div className="flex items-center gap-3 border-b border-border/60 px-3 py-3">
                <div
                  className="size-12 shrink-0 overflow-hidden rounded-full border-2"
                  style={{ borderColor: colorForAgent(selectedPlan.agent_id) + "66" }}
                >
                  {selectedMeta ? (
                    <Avatar
                      style={{ width: "100%", height: "100%" }}
                      {...selectedMeta.config}
                    />
                  ) : (
                    <div
                      className="flex size-full items-center justify-center text-sm font-bold text-zinc-950"
                      style={{
                        backgroundColor: colorForAgent(selectedPlan.agent_id),
                      }}
                    >
                      {selectedPlan.agent_name.slice(0, 1).toUpperCase()}
                    </div>
                  )}
                </div>
                <div className="min-w-0 flex-1">
                  <h3 className="truncate text-sm font-semibold text-foreground">
                    {selectedPlan.agent_name}
                  </h3>
                  <span className="mt-0.5 flex items-center gap-1.5 text-[10px] uppercase tracking-[0.18em] text-amber-400">
                    <span className="inline-block size-1.5 rounded-full bg-amber-400 shadow-[0_0_6px_0_rgb(245,158,11)]" />
                    {following ? "Tracking" : "Selected"}
                  </span>
                </div>
              </div>

              {/* Scroll region: live activity → persona → day timeline */}
              <div className="min-h-0 flex-1 overflow-y-auto">
                {/* Current activity */}
                {selBeat && (
                  <div className="border-b border-border/60 px-3 py-2.5">
                    <div className="flex items-center gap-1.5">
                      <span
                        className="size-1.5 rounded-full"
                        style={{
                          backgroundColor:
                            selInfo?.phase === "travel"
                              ? "#fbbf24"
                              : (ACTIVITY_COLORS[selBeat.activity_type] ??
                                ACTIVITY_COLORS.other),
                        }}
                      />
                      <span className="text-[9px] uppercase tracking-[0.18em] text-muted-foreground">
                        {selInfo?.phase === "travel"
                          ? "In transit"
                          : selBeat.activity_type}
                      </span>
                      <span className="ml-auto font-mono text-[9px] tabular-nums text-muted-foreground/70">
                        {fmtTime(selBeat.start_time)}–{fmtTime(selBeat.end_time)}
                      </span>
                    </div>
                    <div className="mt-1 text-[11px] leading-snug text-foreground/90">
                      {selBeat.activity}
                    </div>
                    <div className="mt-0.5 text-[10px] text-muted-foreground">
                      {selInfo?.phase === "travel" ? "→ " : "@ "}
                      {selBeat.location_name}
                    </div>
                  </div>
                )}

                {/* Persona (from Supabase, if matched) */}
                {selectedMeta?.age != null && (
                  <DiagRow label="Age" value={String(selectedMeta.age)} />
                )}
                {selectedMeta?.location_home && (
                  <DiagRow label="Home" value={selectedMeta.location_home} />
                )}
                {selectedMeta?.location_work && (
                  <DiagRow label="Work" value={selectedMeta.location_work} />
                )}
                {selectedMeta?.personality && (
                  <div className="border-t border-border/60 px-3 py-2.5">
                    <div className="text-[10px] uppercase tracking-[0.18em] text-muted-foreground">
                      Personality
                    </div>
                    <p className="mt-1.5 text-[11px] leading-relaxed text-foreground/85">
                      {selectedMeta.personality}
                    </p>
                  </div>
                )}
                {selectedMeta?.job_description && (
                  <div className="border-t border-border/60 px-3 py-2.5">
                    <div className="text-[10px] uppercase tracking-[0.18em] text-muted-foreground">
                      Job
                    </div>
                    <p className="mt-1.5 text-[11px] leading-relaxed text-foreground/85">
                      {selectedMeta.job_description}
                    </p>
                  </div>
                )}

                {/* Day so far — beats up to the current sim time */}
                <div className="border-t border-border/60 px-3 py-2.5">
                  <div className="flex items-center justify-between text-[10px] uppercase tracking-[0.18em] text-muted-foreground">
                    <span>Day so far</span>
                    <span className="font-mono normal-case tracking-normal text-muted-foreground/60">
                      {
                        selectedPlan.beats.filter(
                          (b) =>
                            new Date(b.start_time).getTime() <=
                            dayStartMs + offsetMs,
                        ).length
                      }
                      /{selectedPlan.beats.length}
                    </span>
                  </div>
                  <ol className="mt-2 space-y-1">
                    {selectedPlan.beats
                      .filter(
                        (b) =>
                          new Date(b.start_time).getTime() <=
                          dayStartMs + offsetMs,
                      )
                      .map((b) => {
                        const isActive = b.index === selInfo?.idx
                        const color =
                          ACTIVITY_COLORS[b.activity_type] ??
                          ACTIVITY_COLORS.other
                        return (
                          <li
                            key={b.index}
                            className={cn(
                              "flex gap-2 rounded-sm border px-2 py-1.5 text-[10px] transition",
                              isActive
                                ? "border-amber-400/60 bg-amber-500/10"
                                : "border-transparent",
                            )}
                          >
                            <span className="mt-1 flex flex-col items-center">
                              <span
                                className="size-2 rounded-full"
                                style={{ backgroundColor: color }}
                              />
                            </span>
                            <div className="min-w-0 flex-1">
                              <div className="flex items-center justify-between gap-2">
                                <span className="truncate font-medium text-foreground/90">
                                  {b.location_name}
                                </span>
                                <span className="shrink-0 font-mono text-[9px] tabular-nums text-muted-foreground/70">
                                  {fmtTime(b.start_time)}
                                </span>
                              </div>
                              <div className="truncate text-[9px] uppercase tracking-[0.12em] text-muted-foreground">
                                {b.activity_type}
                              </div>
                            </div>
                          </li>
                        )
                      })
                      .reverse()}
                  </ol>
                </div>
              </div>
            </div>
          )}
        </div>
      </div>

      {/* BOTTOM: city-activity graph drawer */}
      <div className="shrink-0 border-t border-border/60 bg-card/85 backdrop-blur">
        <div className="flex items-center justify-between px-3 py-1.5">
          <button
            type="button"
            onClick={() => setTimelineOpen((o) => !o)}
            aria-expanded={timelineOpen}
            className="flex items-center gap-2 text-[10px] uppercase tracking-[0.18em] text-muted-foreground transition hover:text-foreground"
          >
            <WaveSine size={12} />
            <span>City Activity</span>
            {timelineOpen ? <CaretDown size={12} /> : <CaretUp size={12} />}
          </button>
          <span className="font-mono text-[10px] uppercase tracking-[0.18em] text-muted-foreground/70">
            {selectedPlan ? selectedPlan.agent_name : `${day.plans.length} agents`}
          </span>
        </div>
        <div
          className={cn(
            "overflow-hidden transition-[max-height] duration-300 ease-out",
            timelineOpen ? "max-h-64" : "max-h-0",
          )}
        >
          <div className="border-t border-border/60 px-3 py-3">
            <TimelineChart
              frames={frames}
              dayLen={dayLen}
              offsetMs={offsetMs}
              selected={
                selectedPlan
                  ? {
                      id: selectedPlan.agent_id,
                      name: selectedPlan.agent_name,
                      color: colorForAgent(selectedPlan.agent_id),
                    }
                  : null
              }
              totalAgents={day.plans.length}
            />
          </div>
        </div>
      </div>

      {/* BOTTOM TRANSPORT */}
      <footer className="shrink-0 border-t border-border/40 bg-[#0a0a0d]">
        <div className="flex flex-wrap items-center gap-3 px-3 py-2">
          <button
            type="button"
            onClick={toggle}
            className="flex h-8 items-center gap-1.5 rounded-sm bg-amber-500 px-3 text-[10px] font-semibold uppercase tracking-[0.18em] text-zinc-950 transition hover:bg-amber-400"
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
          <button
            type="button"
            onClick={reset}
            className="flex h-8 w-8 items-center justify-center rounded-sm text-muted-foreground transition hover:bg-secondary/40 hover:text-foreground"
            aria-label="Reset"
            title="Reset"
          >
            <ArrowsCounterClockwise size={12} />
          </button>

          <span className="font-mono text-[11px] tabular-nums text-foreground">
            {fmtClockFromOffset(offsetMs, dayStartMs)}
          </span>

          {/* Scrubber */}
          <input
            type="range"
            min={0}
            max={dayLen}
            step={1000}
            value={offsetMs}
            onChange={(e) => {
              setPlaying(false)
              setOffsetMs(Number(e.target.value))
            }}
            className="h-1 min-w-40 flex-1 cursor-pointer appearance-none rounded-full bg-secondary/60 accent-amber-400"
          />

          <span className="font-mono text-[10px] tabular-nums text-muted-foreground/70">
            {fmtClockFromOffset(dayLen, dayStartMs)}
          </span>

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
          </div>
        </div>
      </footer>
    </div>
  )
}

function ToggleBtn({
  label,
  active,
  onClick,
  Icon,
  disabled,
}: {
  label: string
  active: boolean
  onClick: () => void
  Icon: React.ComponentType<{ size?: number; weight?: "regular" | "fill" }>
  disabled?: boolean
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      disabled={disabled}
      aria-pressed={active}
      className={cn(
        "flex items-center gap-1.5 rounded-sm px-2 py-1 text-[9px] uppercase tracking-[0.18em] transition disabled:opacity-30",
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

function DiagRow({ label, value }: { label: string; value: string }) {
  return (
    <div className="flex items-center justify-between border-t border-border/60 px-3 py-2 first:border-t-0">
      <span className="text-[10px] uppercase tracking-[0.18em] text-muted-foreground">
        {label}
      </span>
      <span className="font-mono text-[11px] tracking-tight text-foreground">
        {value}
      </span>
    </div>
  )
}

// Deterministic city-activity graph. X axis is the whole sim day; the amber
// area is average city movement, an optional colored line overlays the
// selected agent, and a vertical playhead tracks the current sim offset.
function TimelineChart({
  frames,
  dayLen,
  offsetMs,
  selected,
  totalAgents,
}: {
  frames: TimelineFrame[]
  dayLen: number
  offsetMs: number
  selected: { id: string; name: string; color: string } | null
  totalAgents: number
}) {
  const wrapRef = useRef<HTMLDivElement>(null)
  const [size, setSize] = useState({ w: 800, h: 192 })
  const [hover, setHover] = useState<{ idx: number; x: number; y: number } | null>(
    null,
  )

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

  const popRaw = frames.map((f) => (totalAgents > 0 ? f.total / totalAgents : 0))
  const pop = smooth(popRaw, 7)
  const agentRaw = selected
    ? frames.map((f) => f.perAgent[selected.id] ?? 0)
    : []
  const agent = smooth(agentRaw, 7)

  const maxV = Math.max(1e-9, ...pop, ...agent)
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
  const agentLine = selected ? buildSmoothPath(agent) : ""
  const agentArea = closeArea(agentLine)

  const focused = !!selected
  const popStroke = focused ? AGENT_BACKDROP_COLOR : PULSE_COLOR
  const popFillId = focused ? "grad-pop-dim" : "grad-pop"

  const gridYs = [0, 0.25, 0.5, 0.75, 1].map((p) => padT + innerH * p)

  // Playhead position from the live offset.
  const headFrac = dayLen > 0 ? Math.max(0, Math.min(1, offsetMs / dayLen)) : 0
  const headX = padL + headFrac * innerW

  const hoverIdx = hover ? hover.idx : -1
  const hoverPop = hoverIdx >= 0 ? pop[hoverIdx] ?? 0 : 0
  const hoverAgent = hoverIdx >= 0 && selected ? agent[hoverIdx] ?? 0 : 0
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
          {selected && (
            <linearGradient id="grad-agent" x1="0" y1="0" x2="0" y2="1">
              <stop offset="0%" stopColor={selected.color} stopOpacity={0.9} />
              <stop offset="100%" stopColor={selected.color} stopOpacity={0.1} />
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

        {selected && agentArea && (
          <>
            <path d={agentArea} fill="url(#grad-agent)" stroke="none" />
            <path
              d={agentLine}
              fill="none"
              stroke={selected.color}
              strokeWidth={1.75}
              strokeLinejoin="round"
              strokeLinecap="round"
              filter="url(#glow-agent)"
            />
          </>
        )}

        {/* Playhead */}
        <line
          x1={headX}
          x2={headX}
          y1={padT}
          y2={padT + innerH}
          stroke={PULSE_COLOR}
          strokeWidth={1.5}
          strokeOpacity={0.9}
        />
        <circle cx={headX} cy={padT} r={3} fill={PULSE_COLOR} />

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
            {selected && (
              <circle
                cx={hover.x}
                cy={yAt(hoverAgent)}
                r={3.5}
                fill="#0a0a0c"
                stroke={selected.color}
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
        <span>Wake</span>
        <span>City Movement · Full day</span>
        <span>Sleep</span>
      </div>

      {hover && (
        <div
          className="pointer-events-none absolute z-10 rounded-sm border border-border/70 bg-[#0a0a0c]/95 px-2.5 py-1.5 font-mono text-[10px] uppercase tracking-[0.18em] shadow-xl backdrop-blur"
          style={{
            left: Math.min(hover.x + 12, W - 170),
            top: Math.max(padT, Math.min(yAt(hoverPop), yAt(hoverAgent)) - 36),
          }}
        >
          {selected ? (
            <>
              <div className="flex items-center gap-1.5">
                <span
                  className="inline-block size-1.5 rounded-full"
                  style={{ backgroundColor: selected.color }}
                />
                <span className="text-foreground tabular-nums">
                  {hoverAgentPct.toFixed(1)}%
                </span>
                <span className="text-muted-foreground">{selected.name}</span>
              </div>
              <div className="mt-0.5 flex items-center gap-1.5">
                <span
                  className="inline-block size-1.5 rounded-full"
                  style={{ backgroundColor: AGENT_BACKDROP_COLOR }}
                />
                <span className="text-foreground/70 tabular-nums">
                  {hoverPopPct.toFixed(1)}%
                </span>
                <span className="text-muted-foreground">City Avg</span>
              </div>
            </>
          ) : (
            <>
              <div className="text-muted-foreground">City Movement</div>
              <div className="mt-0.5 text-foreground tabular-nums">
                {hoverPopPct.toFixed(1)}%
              </div>
            </>
          )}
        </div>
      )}

      <div className="pointer-events-none absolute left-3 top-2 flex items-center gap-3 font-mono text-[10px] uppercase tracking-[0.18em]">
        {selected ? (
          <>
            <span className="flex items-center gap-1.5">
              <span
                className="inline-block size-1.5 rounded-full"
                style={{ backgroundColor: selected.color }}
              />
              <span className="text-foreground">{selected.name}</span>
            </span>
            <span className="flex items-center gap-1.5 text-muted-foreground">
              <span
                className="inline-block size-1.5 rounded-full"
                style={{ backgroundColor: AGENT_BACKDROP_COLOR }}
              />
              City Avg
            </span>
          </>
        ) : (
          <span className="flex items-center gap-1.5">
            <span
              className="inline-block size-1.5 rounded-full"
              style={{ backgroundColor: PULSE_COLOR }}
            />
            <span className="text-foreground">City Movement</span>
          </span>
        )}
      </div>
    </div>
  )
}

// --- Map helpers ----------------------------------------------------------

function installLayers(map: mapboxgl.Map) {
  if (!map.getContainer?.()) return

  // Selected agent's planned route (faint).
  if (!map.getSource("sel-route")) {
    map.addSource("sel-route", {
      type: "geojson",
      data: { type: "FeatureCollection", features: [] },
    })
    map.addLayer({
      id: "sel-route-line",
      type: "line",
      source: "sel-route",
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
        "line-width": 2.5,
        "line-opacity": 0.5,
      },
    })
  }

  // All agents — one circle layer.
  if (!map.getSource("agents-src")) {
    map.addSource("agents-src", {
      type: "geojson",
      data: { type: "FeatureCollection", features: [] },
    })
    // Citywide activity heatmap (hidden until toggled). Fed by a dedicated
    // trail source that accumulates recent positions with decaying weight,
    // so the "action" leaves comet-like trails and lingers a moment.
    if (!map.getSource("heat-src")) {
      map.addSource("heat-src", {
        type: "geojson",
        data: { type: "FeatureCollection", features: [] },
      })
    }
    map.addLayer({
      id: "agents-heat",
      type: "heatmap",
      source: "heat-src",
      layout: { visibility: "none" },
      paint: {
        "heatmap-weight": ["get", "weight"],
        "heatmap-intensity": [
          "interpolate",
          ["linear"],
          ["zoom"],
          10,
          0.8,
          16,
          1.8,
        ],
        "heatmap-radius": [
          "interpolate",
          ["linear"],
          ["zoom"],
          10,
          16,
          16,
          40,
        ],
        "heatmap-color": [
          "interpolate",
          ["linear"],
          ["heatmap-density"],
          0,
          "rgba(10,10,13,0)",
          0.2,
          "#1e3a8a",
          0.4,
          "#0891b2",
          0.6,
          "#22c55e",
          0.8,
          "#f59e0b",
          1,
          "#ef4444",
        ],
        "heatmap-opacity": 0.8,
      },
    })
    // Soft glow under the selected agent.
    map.addLayer({
      id: "agents-glow",
      type: "circle",
      source: "agents-src",
      filter: ["==", ["get", "selected"], true],
      paint: {
        "circle-radius": ["interpolate", ["linear"], ["zoom"], 12, 16, 17, 28],
        "circle-color": "#f59e0b",
        "circle-opacity": 0.18,
        "circle-blur": 0.8,
      },
    })
    map.addLayer({
      id: "agents-dot",
      type: "circle",
      source: "agents-src",
      paint: {
        "circle-radius": [
          "interpolate",
          ["linear"],
          ["zoom"],
          11,
          ["case", ["get", "selected"], 6, 4],
          17,
          ["case", ["get", "selected"], 11, 7],
        ],
        "circle-color": ["get", "color"],
        "circle-stroke-color": [
          "case",
          ["get", "selected"],
          "#fde68a",
          "#0a0a0d",
        ],
        "circle-stroke-width": ["case", ["get", "selected"], 2.5, 1.5],
      },
    })
  }
}

// Toggle between the per-agent dots and the citywide density heatmap.
function applyHeatmap(map: mapboxgl.Map, on: boolean) {
  const set = (id: string, vis: "visible" | "none") => {
    if (map.getLayer(id)) map.setLayoutProperty(id, "visibility", vis)
  }
  set("agents-heat", on ? "visible" : "none")
  set("agents-dot", on ? "none" : "visible")
  set("agents-glow", on ? "none" : "visible")
}

function fitToDay(map: mapboxgl.Map, day: Day) {
  const coords: LngLat[] = []
  for (const plan of day.plans) {
    for (const b of plan.beats) coords.push(b.location)
  }  if (coords.length < 2) return
  const bounds = coords.reduce(
    (acc, c) => acc.extend(c),
    new mapboxgl.LngLatBounds(coords[0], coords[0]),
  )
  map.fitBounds(bounds, { padding: 100, duration: 400, maxZoom: 14 })
}

function enable3D(map: mapboxgl.Map) {
  map.easeTo({ pitch: 55 })
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
    total += haversine(polyline[i - 1], polyline[i])
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

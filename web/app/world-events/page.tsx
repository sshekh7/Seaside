"use client"

import { useState, useEffect } from "react"
import { Button } from "@/components/ui/button"
import { Input } from "@/components/ui/input"

const SWARM_PRESETS = [
  { event: "Free concert at Gas Works Park tonight at 7 PM — all ages, food trucks!", location: "Gas Works Park, Seattle", time: 19 },
  { event: "Flash sale at Pike Place Market at noon — 50% off everything!", location: "Pike Place Market, Seattle", time: 12 },
  { event: "Celebrity spotted at Starbucks Reserve at 3 PM — crowd gathering", location: "Starbucks Reserve Roastery, Capitol Hill", time: 15 },
  { event: "Food truck festival at South Lake Union Park starting 6 PM!", location: "South Lake Union Park, Seattle", time: 18 },
  { event: "Protest march at Westlake Center at 5 PM", location: "Westlake Center, Seattle", time: 17 },
  { event: "Pop-up art show at Pioneer Square at 8 PM — free entry", location: "Pioneer Square, Seattle", time: 20 },
  { event: "Pokémon Go community day at Green Lake at 2 PM!", location: "Green Lake Park, Seattle", time: 14 },
  { event: "Fireworks at Kerry Park at 9 PM for summer kickoff!", location: "Kerry Park, Seattle", time: 21 },
]

export default function WorldEventsPage() {
  const [events, setEvents] = useState<string[]>([])
  const [swarmTarget, setSwarmTarget] = useState<{ lng: number; lat: number; label: string } | null>(null)
  const [customEvent, setCustomEvent] = useState("")
  const [customLocation, setCustomLocation] = useState("")
  const [customTime, setCustomTime] = useState("19")
  const [customCount, setCustomCount] = useState("50")
  const [loading, setLoading] = useState(false)

  const fetchState = async () => {
    const [evRes, swRes] = await Promise.all([
      fetch("/api/world-events"),
      fetch("/api/swarm"),
    ])
    const evData = await evRes.json()
    const swData = await swRes.json()
    setEvents(evData.events || [])
    setSwarmTarget(swData.target || null)
  }

  useEffect(() => { fetchState() }, [])

  const triggerSwarm = async (event: string, location: string, timeHour?: number, agentCount?: number) => {
    setLoading(true)
    await fetch("/api/swarm", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ event, location, timeHour: timeHour || 19, agentCount: agentCount || 50 }),
    })
    await fetchState()
    setLoading(false)
  }

  const clearSwarm = async () => {
    await fetch("/api/swarm", { method: "DELETE" })
    await fetchState()
  }

  return (
    <div className="flex h-svh flex-col bg-background text-foreground">
      <header className="flex items-center justify-between border-b border-border/60 px-6 py-3">
        <h1 className="text-sm font-medium uppercase tracking-[0.18em]">World Events — Demo</h1>
        {swarmTarget && (
          <Button variant="ghost" size="sm" onClick={clearSwarm}>Clear</Button>
        )}
      </header>

      <div className="flex min-h-0 flex-1 gap-0">
        {/* Left: trigger swarm */}
        <div className="w-1/2 overflow-y-auto border-r border-border/60 p-6">
          <p className="mb-4 text-[10px] uppercase tracking-[0.18em] text-muted-foreground">Inject Event</p>

          <div className="mb-6 space-y-2">
            <Input value={customEvent} onChange={(e) => setCustomEvent(e.target.value)} placeholder="Event description..." />
            <Input value={customLocation} onChange={(e) => setCustomLocation(e.target.value)} placeholder="Location (e.g. Gas Works Park)" />
            <div className="flex gap-2">
              <Input type="number" value={customTime} onChange={(e) => setCustomTime(e.target.value)} placeholder="Hour (24h)" className="w-24" />
              <Input type="number" value={customCount} onChange={(e) => setCustomCount(e.target.value)} placeholder="# agents" className="w-24" />
            </div>
            <Button size="sm" disabled={!customEvent.trim() || !customLocation.trim() || loading}
              onClick={() => { triggerSwarm(customEvent, customLocation, parseInt(customTime) || 19, parseInt(customCount) || 50); setCustomEvent(""); setCustomLocation("") }}>
              Inject
            </Button>
          </div>

          <p className="mb-3 text-[10px] uppercase tracking-[0.18em] text-muted-foreground">Presets (click to trigger)</p>
          <div className="space-y-2">
            {SWARM_PRESETS.map((p) => (
              <button key={p.location} onClick={() => triggerSwarm(p.event, p.location, p.time, 50)} disabled={loading}
                className="w-full rounded border border-border/60 px-3 py-2 text-left transition hover:border-foreground/30 hover:text-foreground">
                <p className="text-xs text-foreground">{p.event}</p>
                <p className="text-[10px] text-muted-foreground">📍 {p.location} · 🕐 {p.time}:00</p>
              </button>
            ))}
          </div>
        </div>

        {/* Right: status */}
        <div className="w-1/2 overflow-y-auto p-6">
          {swarmTarget && (
            <div className="mb-6 rounded border border-green-500/30 bg-green-500/5 p-4">
              <p className="text-[10px] uppercase tracking-[0.18em] text-green-400">🎯 Swarm Active</p>
              <p className="mt-1 text-sm font-medium">{swarmTarget.label}</p>
              <p className="text-xs text-muted-foreground">{swarmTarget.lng.toFixed(4)}, {swarmTarget.lat.toFixed(4)}</p>
            </div>
          )}

          <p className="mb-3 text-[10px] uppercase tracking-[0.18em] text-muted-foreground">Active Events ({events.length})</p>
          <div className="space-y-2">
            {events.map((e, i) => (
              <div key={i} className="rounded border border-border/60 px-3 py-2 text-sm">{e}</div>
            ))}
          </div>
        </div>
      </div>
    </div>
  )
}

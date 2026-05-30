"use client"

import { useState, useEffect } from "react"
import { Button } from "@/components/ui/button"
import { Input } from "@/components/ui/input"

const SWARM_PRESETS = [
  { event: "Free concert at Gas Works Park tonight — all ages, food trucks!", location: "Gas Works Park, Seattle" },
  { event: "Flash sale at Pike Place Market — 50% off everything for 1 hour!", location: "Pike Place Market, Seattle" },
  { event: "Celebrity spotted at Starbucks Reserve Roastery — crowd gathering", location: "Starbucks Reserve Roastery, Capitol Hill" },
  { event: "Food truck festival at South Lake Union Park — free samples!", location: "South Lake Union Park, Seattle" },
  { event: "Protest march gathering at Westlake Center", location: "Westlake Center, Seattle" },
  { event: "Fire alarm at Amazon HQ — building evacuated to nearby park", location: "Denny Park, Seattle" },
  { event: "Pop-up art show at Pioneer Square — free entry tonight only", location: "Pioneer Square, Seattle" },
  { event: "Pokémon Go community day at Green Lake — rare spawns!", location: "Green Lake Park, Seattle" },
]

export default function WorldEventsPage() {
  const [events, setEvents] = useState<string[]>([])
  const [swarmTarget, setSwarmTarget] = useState<{ lng: number; lat: number; label: string } | null>(null)
  const [customEvent, setCustomEvent] = useState("")
  const [customLocation, setCustomLocation] = useState("")
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

  const triggerSwarm = async (event: string, location: string) => {
    setLoading(true)
    await fetch("/api/swarm", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ event, location }),
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
          <Button variant="ghost" size="sm" onClick={clearSwarm}>Clear Swarm</Button>
        )}
      </header>

      <div className="flex min-h-0 flex-1 gap-0">
        {/* Left: trigger swarm */}
        <div className="w-1/2 overflow-y-auto border-r border-border/60 p-6">
          <p className="mb-4 text-[10px] uppercase tracking-[0.18em] text-muted-foreground">Trigger Agent Swarm</p>

          <div className="mb-6 space-y-2">
            <Input value={customEvent} onChange={(e) => setCustomEvent(e.target.value)} placeholder="Event description..." />
            <Input value={customLocation} onChange={(e) => setCustomLocation(e.target.value)} placeholder="Location (e.g. Gas Works Park)" />
            <Button size="sm" disabled={!customEvent.trim() || !customLocation.trim() || loading}
              onClick={() => { triggerSwarm(customEvent, customLocation); setCustomEvent(""); setCustomLocation("") }}>
              Trigger Swarm
            </Button>
          </div>

          <p className="mb-3 text-[10px] uppercase tracking-[0.18em] text-muted-foreground">Presets (click to trigger)</p>
          <div className="space-y-2">
            {SWARM_PRESETS.map((p) => (
              <button key={p.location} onClick={() => triggerSwarm(p.event, p.location)} disabled={loading}
                className="w-full rounded border border-border/60 px-3 py-2 text-left transition hover:border-foreground/30 hover:text-foreground">
                <p className="text-xs text-foreground">{p.event}</p>
                <p className="text-[10px] text-muted-foreground">📍 {p.location}</p>
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

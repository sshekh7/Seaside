import { NextRequest, NextResponse } from "next/server"
import { addWorldEvent, setSwarmTarget } from "@/lib/world-events"

const TOKEN = process.env.NEXT_PUBLIC_MAPBOX_TOKEN!

async function geocode(place: string): Promise<{ lng: number; lat: number } | null> {
  try {
    const res = await fetch(
      `https://api.mapbox.com/search/searchbox/v1/forward?q=${encodeURIComponent(place + ", Seattle WA")}&proximity=-122.33,47.61&limit=1&access_token=${TOKEN}`
    )
    const data = await res.json()
    const coords = data.features?.[0]?.geometry?.coordinates
    return coords ? { lng: coords[0], lat: coords[1] } : null
  } catch { return null }
}

// POST: inject event + set swarm target
export async function POST(req: NextRequest) {
  const { event, location } = await req.json()
  if (!event || !location) {
    return NextResponse.json({ error: "event and location required" }, { status: 400 })
  }

  // Geocode the location
  const coords = await geocode(location)
  if (!coords) {
    return NextResponse.json({ error: `Could not geocode: ${location}` }, { status: 400 })
  }

  // Set the swarm target and add event
  setSwarmTarget({ ...coords, label: location })
  addWorldEvent(event)

  return NextResponse.json({ event, target: { ...coords, label: location } })
}

// DELETE: clear swarm
export async function DELETE() {
  setSwarmTarget(null)
  return NextResponse.json({ cleared: true })
}

// GET: current swarm target
export async function GET() {
  const { getSwarmTarget } = await import("@/lib/world-events")
  return NextResponse.json({ target: getSwarmTarget() })
}

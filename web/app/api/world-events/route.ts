import { NextRequest, NextResponse } from "next/server"
import { getWorldEvents, setWorldEvents, addWorldEvent } from "@/lib/world-events"

export async function GET() {
  return NextResponse.json({ events: getWorldEvents() })
}

export async function POST(req: NextRequest) {
  const { event, events: bulkEvents } = await req.json()

  if (bulkEvents && Array.isArray(bulkEvents)) {
    setWorldEvents(bulkEvents)
  } else if (event) {
    addWorldEvent(event)
  } else {
    return NextResponse.json({ error: "event or events required" }, { status: 400 })
  }

  return NextResponse.json({ events: getWorldEvents() })
}

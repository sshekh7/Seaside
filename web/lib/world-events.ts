// Shared in-memory world events store
let worldEvents: string[] = ["Sunny day in Seattle, 68°F. Light breeze."]
let swarmTarget: { lng: number; lat: number; label: string; timeHour: number; agentCount: number } | null = null

export function getWorldEvents(): string[] {
  return worldEvents
}

export function setWorldEvents(events: string[]) {
  worldEvents = events
}

export function addWorldEvent(event: string) {
  worldEvents.unshift(event)
  worldEvents = worldEvents.slice(0, 10)
}

export function getSwarmTarget() {
  return swarmTarget
}

export function setSwarmTarget(target: { lng: number; lat: number; label: string; timeHour: number; agentCount: number } | null) {
  swarmTarget = target
}

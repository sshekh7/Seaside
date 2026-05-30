// Shared types for the planning experiment. These mirror docs/ENGINEERING.md §3.7.

export type ActivityType =
  | "commute"
  | "work"
  | "meal"
  | "errand"
  | "social"
  | "exercise"
  | "leisure"
  | "sleep"
  | "home"
  | "other"

export type TravelMode = "walking" | "driving" | "cycling"

export type Beat = {
  index: number
  start_time: string // ISO
  end_time: string // ISO
  activity: string
  activity_type: ActivityType
  location_name: string
  location: [number, number] // [lng, lat]
  travel_from_prev: null | {
    mode: TravelMode
    polyline: [number, number][]
    duration_minutes: number
  }
  reasoning: string
}

export type SkeletonBeat = {
  index: number
  start_time: string
  end_time: string
  activity: string
  activity_type: ActivityType
  location_name: string
  reasoning: string
}

export type AgentRow = {
  id: string
  name: string
  age: number | null
  job_description: string | null
  location_home: string | null
  location_work: string | null
  personality: string | null
}

export type AgentState = {
  location: [number, number]
  energy: number
  notes: string
}

export type AgentDayPlan = {
  sim_date: string // YYYY-MM-DD
  day_number: number
  agent_id: string
  agent_name: string
  status: "ready" | "reused" | "stayed_home" | "failed"
  beats: Beat[]
  diary: string
  thought_process: string
  end_state: AgentState
  world_event_prompt: string
  generated_at: string
  stats: {
    skeleton_attempts: number
    repair_used: boolean
    geocode_misses: number
    route_misses: number
    overflow_fixed_by_shift: number
    overflow_remaining: number
    compressed_to_fit_day: boolean
    compressed_minutes_saved: number
    sleep_beat_synthesized: boolean
    returned_home_before_sleep: boolean
    llm_ms: number
    mapbox_ms: number
    total_ms: number
  }
}

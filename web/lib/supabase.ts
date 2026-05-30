import { createClient } from "@supabase/supabase-js";

export const supabase = createClient(
  process.env.NEXT_PUBLIC_SUPABASE_URL!,
  process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY!
);

export type Agent = {
  id: string
  name: string
  profile_pic: Record<string, unknown> | null
  job_description: string | null
  location_work: string | null
  location_home: string | null
  age: number | null
  personality: string | null
  created_at: string
}

export type Memory = {
  id: string
  agent_id: string
  time_start: string
  time_end: string | null
  activity: string
  created_at: string
}

/** A single beat in a generated day plan (written to experiments/output/plans/) */
export type PlanBeat = {
  index: number
  start_time: string
  end_time: string
  activity: string
  activity_type: string
  location_name: string
  location: { lat: number; lng: number } | null
  reasoning: string
}

export type DayPlan = {
  sim_date: string
  day_number: number
  agent_id: string
  agent_name: string
  beats: PlanBeat[]
  diary: string
  thought_process: string
  generated_at: string
}

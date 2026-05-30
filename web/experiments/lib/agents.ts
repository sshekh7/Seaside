// Pull agents from Supabase (anon, read-only). The experiment treats agents as
// immutable; we only ever read.

import { createClient } from "@supabase/supabase-js"
import type { AgentRow } from "./types"

const url = process.env.NEXT_PUBLIC_SUPABASE_URL!
const key = process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY!
if (!url || !key) throw new Error("Supabase env vars missing")

const client = createClient(url, key)

export async function listAgents(): Promise<AgentRow[]> {
  const { data, error } = await client
    .from("agents")
    .select("id, name, age, job_description, location_home, location_work, personality")
  if (error) throw error
  return (data ?? []) as AgentRow[]
}

export async function getAgent(id: string): Promise<AgentRow | null> {
  const { data, error } = await client
    .from("agents")
    .select("id, name, age, job_description, location_home, location_work, personality")
    .eq("id", id)
    .maybeSingle()
  if (error) throw error
  return (data as AgentRow | null) ?? null
}

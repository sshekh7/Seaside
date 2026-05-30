"use client"

import { useEffect, useState } from "react"
import dynamic from "next/dynamic"
import { Trash } from "@phosphor-icons/react/dist/ssr"
import type { NiceAvatarProps } from "react-nice-avatar"

import { supabase } from "@/lib/supabase"

const Avatar = dynamic(() => import("react-nice-avatar"), {
  ssr: false,
  loading: () => <div className="size-full animate-pulse rounded-full bg-muted/40" />,
}) as React.ComponentType<NiceAvatarProps>

type Agent = {
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

type Memory = {
  id: string
  agent_id: string
  time_start: string
  time_end: string | null
  activity: string
  created_at: string
}

export default function DatabasePage() {
  const [agents, setAgents] = useState<Agent[]>([])
  const [memories, setMemories] = useState<Memory[]>([])
  const [selectedAgent, setSelectedAgent] = useState<string | null>(null)

  const fetchAgents = async () => {
    const { data } = await supabase.from("agents").select("*").order("created_at", { ascending: false })
    if (data) setAgents(data)
  }

  const fetchMemories = async (agentId: string) => {
    const { data } = await supabase.from("memory").select("*").eq("agent_id", agentId).order("time_start", { ascending: false })
    if (data) setMemories(data)
  }

  useEffect(() => { fetchAgents() }, [])

  useEffect(() => {
    if (selectedAgent) fetchMemories(selectedAgent)
    else setMemories([])
  }, [selectedAgent])

  const deleteAgent = async (id: string) => {
    await supabase.from("agents").delete().eq("id", id)
    if (selectedAgent === id) setSelectedAgent(null)
    fetchAgents()
  }

  return (
    <div className="flex h-svh flex-col bg-background text-foreground">
      <header className="flex items-center border-b border-border/60 px-6 py-3">
        <h1 className="text-sm font-medium uppercase tracking-[0.18em]">Database</h1>
        <span className="ml-3 text-xs text-muted-foreground">{agents.length} agents</span>
      </header>

      <div className="flex min-h-0 flex-1">
        {/* Agents list */}
        <div className="w-80 shrink-0 overflow-y-auto border-r border-border/60">
          <div className="px-4 py-3 text-[10px] uppercase tracking-[0.18em] text-muted-foreground">Agents</div>
          {agents.length === 0 && (
            <p className="px-4 py-8 text-center text-xs text-muted-foreground">No agents yet. Create one from the sidebar.</p>
          )}
          {agents.map((agent) => (
            <div
              key={agent.id}
              onClick={() => setSelectedAgent(agent.id)}
              className={`flex w-full cursor-pointer items-center gap-3 border-b border-border/40 px-4 py-3 text-left transition hover:bg-secondary/40 ${selectedAgent === agent.id ? "bg-secondary/60" : ""}`}
            >
              <div className="size-9 shrink-0 overflow-hidden rounded-full border border-border/60">
                {agent.profile_pic && <Avatar style={{ width: "100%", height: "100%" }} {...agent.profile_pic} />}
              </div>
              <div className="min-w-0 flex-1">
                <p className="truncate text-sm font-medium">{agent.name}</p>
                <p className="truncate text-xs text-muted-foreground">{agent.job_description || agent.personality || "No description"}</p>
              </div>
              <button
                onClick={(e) => { e.stopPropagation(); deleteAgent(agent.id) }}
                className="rounded p-1 text-muted-foreground/50 transition hover:bg-destructive/10 hover:text-destructive"
                aria-label="Delete agent"
              >
                <Trash size={14} />
              </button>
            </div>
          ))}
        </div>

        {/* Agent detail + memory */}
        <div className="flex-1 overflow-y-auto p-6">
          {!selectedAgent && (
            <div className="flex h-full items-center justify-center text-xs uppercase tracking-[0.18em] text-muted-foreground">
              Select an agent to view details
            </div>
          )}
          {selectedAgent && (() => {
            const agent = agents.find((a) => a.id === selectedAgent)
            if (!agent) return null
            return (
              <div className="mx-auto max-w-2xl space-y-6">
                {/* Profile */}
                <div className="flex items-center gap-4">
                  <div className="size-16 overflow-hidden rounded-full border-2 border-border/60">
                    {agent.profile_pic && <Avatar style={{ width: "100%", height: "100%" }} {...agent.profile_pic} />}
                  </div>
                  <div>
                    <h2 className="text-lg font-semibold">{agent.name}</h2>
                    <p className="text-xs text-muted-foreground">Created {new Date(agent.created_at).toLocaleDateString()}</p>
                  </div>
                </div>

                {/* Details grid */}
                <div className="grid grid-cols-2 gap-3 rounded-md border border-border/60 p-4">
                  {agent.age && <Field label="Age" value={String(agent.age)} />}
                  {agent.job_description && <Field label="Job" value={agent.job_description} />}
                  {agent.location_home && <Field label="Home" value={agent.location_home} />}
                  {agent.location_work && <Field label="Work" value={agent.location_work} />}
                  {agent.personality && <div className="col-span-2"><Field label="Personality" value={agent.personality} /></div>}
                </div>

                {/* Memory */}
                <div>
                  <h3 className="mb-3 text-[10px] uppercase tracking-[0.18em] text-muted-foreground">Memory ({memories.length})</h3>
                  {memories.length === 0 && (
                    <div className="rounded-md border border-dashed border-border/60 px-4 py-8 text-center text-xs text-muted-foreground">
                      No memories recorded yet.
                    </div>
                  )}
                  <div className="space-y-2">
                    {memories.map((m) => (
                      <div key={m.id} className="rounded-md border border-border/60 px-3 py-2">
                        <p className="text-sm">{m.activity}</p>
                        <p className="mt-1 text-[10px] text-muted-foreground">
                          {new Date(m.time_start).toLocaleString()}
                          {m.time_end && ` → ${new Date(m.time_end).toLocaleString()}`}
                        </p>
                      </div>
                    ))}
                  </div>
                </div>
              </div>
            )
          })()}
        </div>
      </div>
    </div>
  )
}

function Field({ label, value }: { label: string; value: string }) {
  return (
    <div>
      <p className="text-[10px] uppercase tracking-[0.18em] text-muted-foreground">{label}</p>
      <p className="mt-0.5 text-sm">{value}</p>
    </div>
  )
}

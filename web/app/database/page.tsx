"use client"

import { useCallback, useEffect, useRef, useState } from "react"
import dynamic from "next/dynamic"
import { CircleNotch, MagnifyingGlass, Trash, X } from "@phosphor-icons/react/dist/ssr"
import type { NiceAvatarProps } from "react-nice-avatar"

import { supabase } from "@/lib/supabase"

const PAGE_SIZE = 30
const SEARCH_DEBOUNCE_MS = 350

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
  const [search, setSearch] = useState("")
  const [debouncedSearch, setDebouncedSearch] = useState("")
  const [hasMore, setHasMore] = useState(true)
  const [loading, setLoading] = useState(false)
  const [totalCount, setTotalCount] = useState(0)
  const sentinelRef = useRef<HTMLDivElement | null>(null)
  const loadingRef = useRef(false)
  const hasMoreRef = useRef(true)
  const searchRef = useRef("")

  useEffect(() => {
    const trimmed = search.trim()
    if (trimmed === debouncedSearch) return
    const id = setTimeout(() => setDebouncedSearch(trimmed), SEARCH_DEBOUNCE_MS)
    return () => clearTimeout(id)
  }, [search, debouncedSearch])

  const isPendingSearch = search.trim() !== debouncedSearch
  const isInitialLoading = loading && agents.length === 0

  const loadPage = useCallback(async (from: number, query: string, replace: boolean) => {
    if (loadingRef.current) return
    loadingRef.current = true
    setLoading(true)
    let q = supabase
      .from("agents")
      .select("*", { count: "exact" })
      .order("created_at", { ascending: false })
      .order("id", { ascending: false })
      .range(from, from + PAGE_SIZE - 1)
    if (query) {
      const pattern = `%${query.replace(/[%_]/g, (m) => `\\${m}`)}%`
      q = q.or(
        `name.ilike.${pattern},job_description.ilike.${pattern},personality.ilike.${pattern},location_home.ilike.${pattern},location_work.ilike.${pattern}`,
      )
    }
    const { data, count } = await q
    if (searchRef.current !== query) {
      loadingRef.current = false
      setLoading(false)
      return
    }
    if (data) {
      setAgents((prev) => {
        const next = replace ? data : [...prev, ...data]
        const more = count != null ? next.length < count : data.length === PAGE_SIZE
        hasMoreRef.current = more
        setHasMore(more)
        return next
      })
      if (count != null) setTotalCount(count)
    }
    loadingRef.current = false
    setLoading(false)
  }, [])

  useEffect(() => {
    searchRef.current = debouncedSearch
    hasMoreRef.current = true
    setHasMore(true)
    setAgents([])
    loadPage(0, debouncedSearch, true)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [debouncedSearch])

  useEffect(() => {
    const el = sentinelRef.current
    if (!el) return
    const io = new IntersectionObserver((entries) => {
      const entry = entries[0]
      if (entry.isIntersecting && hasMoreRef.current && !loadingRef.current) {
        loadPage(agents.length, searchRef.current, false)
      }
    }, { rootMargin: "200px" })
    io.observe(el)
    return () => io.disconnect()
  }, [agents.length, loadPage])

  const fetchMemories = async (agentId: string) => {
    const { data } = await supabase.from("memory").select("*").eq("agent_id", agentId).order("time_start", { ascending: false })
    if (data) setMemories(data)
  }

  useEffect(() => {
    if (selectedAgent) fetchMemories(selectedAgent)
    else setMemories([])
  }, [selectedAgent])

  const deleteAgent = async (id: string) => {
    const agent = agents.find((a) => a.id === id)
    await supabase.from("agents").delete().eq("id", id)
    if (agent) {
      fetch("/api/agent/delete-plans", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ agent_name: agent.name }),
      })
    }
    if (selectedAgent === id) setSelectedAgent(null)
    setAgents((prev) => prev.filter((a) => a.id !== id))
    setTotalCount((c) => Math.max(0, c - 1))
  }

  return (
    <div className="flex h-svh flex-col bg-background text-foreground">
      <header className="flex items-center border-b border-border/60 px-6 py-3">
        <h1 className="text-sm font-medium uppercase tracking-[0.18em]">Database</h1>
        <span className="ml-3 text-xs text-muted-foreground">{totalCount} agents</span>
      </header>

      <div className="flex min-h-0 flex-1">
        {/* Agents list */}
        <div className="flex w-80 shrink-0 flex-col border-r border-border/60">
          <div className="border-b border-border/60 p-3">
            <div className="relative">
              <MagnifyingGlass
                size={14}
                className="pointer-events-none absolute left-3 top-1/2 -translate-y-1/2 text-muted-foreground"
              />
              <input
                type="search"
                value={search}
                onChange={(e) => setSearch(e.target.value)}
                placeholder="Search agents…"
                className="w-full rounded-md border border-border/60 bg-secondary/30 py-2 pl-9 pr-9 text-sm placeholder:text-muted-foreground/70 focus:border-border focus:outline-none focus:ring-1 focus:ring-border"
              />
              <div className="pointer-events-none absolute right-3 top-1/2 -translate-y-1/2 flex items-center">
                {isPendingSearch || (loading && debouncedSearch) ? (
                  <CircleNotch size={14} className="animate-spin text-muted-foreground" />
                ) : search ? (
                  <button
                    type="button"
                    onClick={() => setSearch("")}
                    className="pointer-events-auto rounded p-0.5 text-muted-foreground/60 transition hover:bg-secondary hover:text-foreground"
                    aria-label="Clear search"
                  >
                    <X size={12} />
                  </button>
                ) : null}
              </div>
            </div>
          </div>
          <div className="min-h-0 flex-1 overflow-y-auto">
            <div className="flex items-center justify-between px-4 py-3 text-[10px] uppercase tracking-[0.18em] text-muted-foreground">
              <span>{debouncedSearch ? `Results (${agents.length})` : "Agents"}</span>
              {isPendingSearch && <span className="normal-case tracking-normal text-muted-foreground/60">typing…</span>}
            </div>
            {isInitialLoading && (
              <div className="space-y-px">
                {Array.from({ length: 6 }).map((_, i) => (
                  <div key={i} className="flex items-center gap-3 border-b border-border/40 px-4 py-3">
                    <div className="size-9 shrink-0 animate-pulse rounded-full bg-muted/40" />
                    <div className="min-w-0 flex-1 space-y-1.5">
                      <div className="h-3 w-2/3 animate-pulse rounded bg-muted/40" />
                      <div className="h-2.5 w-4/5 animate-pulse rounded bg-muted/30" />
                    </div>
                  </div>
                ))}
              </div>
            )}
            {!isInitialLoading && agents.length === 0 && (
              <p className="px-4 py-8 text-center text-xs text-muted-foreground">
                {debouncedSearch ? "No matching agents." : "No agents yet. Create one from the sidebar."}
              </p>
            )}
            <div className={`transition-opacity duration-150 ${isPendingSearch ? "opacity-60" : "opacity-100"}`}>
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
            <div ref={sentinelRef} className="h-8" />
            {loading && agents.length > 0 && (
              <div className="flex items-center justify-center gap-2 px-4 py-3 text-[10px] uppercase tracking-[0.18em] text-muted-foreground">
                <CircleNotch size={12} className="animate-spin" /> Loading
              </div>
            )}
            {!hasMore && agents.length > 0 && !loading && (
              <p className="px-4 py-3 text-center text-[10px] uppercase tracking-[0.18em] text-muted-foreground/60">End of list</p>
            )}
          </div>
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

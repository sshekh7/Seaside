"use client"

import { useState, useEffect, useCallback } from "react"
import { ArrowRight, CircleNotch, Info, Key, Lightning, Newspaper, Play } from "@phosphor-icons/react/dist/ssr"
import { Button } from "@/components/ui/button"
import { Input } from "@/components/ui/input"

type ScrapeItem = { title: string; source?: string; snippet?: string; url?: string }
type WorldEvent = { id: string; summary: string; scrape_query: string; headlines: string[]; box_file_id: string; created_at: string }

export default function PipelinePage() {
  const [phase, setPhase] = useState<"idle" | "scraping" | "scraped" | "uploading" | "summarized">("idle")
  const [items, setItems] = useState<ScrapeItem[]>([])
  const [history, setHistory] = useState<WorldEvent[]>([])
  const [summary, setSummary] = useState<string | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [query, setQuery] = useState("Seattle news today")
  const [polling, setPolling] = useState(false)
  const [boxToken, setBoxToken] = useState("")
  const [tokenSet, setTokenSet] = useState(false)
  const [showInfo, setShowInfo] = useState(false)
  const [expiresAt, setExpiresAt] = useState<number | null>(null)
  const [timeLeft, setTimeLeft] = useState("")
  const [tokenError, setTokenError] = useState("")

  const loadData = useCallback(async () => {
    const histRes = await fetch("/api/pipeline?action=history").then(r => r.json()).catch(() => ({ events: [] }))
    setHistory(histRes.events || [])
  }, [])

  useEffect(() => { loadData() }, [loadData])

  // Fetch token expiry and tick countdown
  useEffect(() => {
    fetch("/api/pipeline?action=token_status").then(r => r.json()).then(d => {
      if (d.expiresAt) setExpiresAt(d.expiresAt)
    }).catch(() => {})
  }, [tokenSet])

  useEffect(() => {
    if (!expiresAt) { setTimeLeft(""); return }
    const tick = () => {
      const remaining = expiresAt - Date.now()
      if (remaining <= 0) { setTimeLeft("expired"); setTokenSet(false); return }
      const m = Math.floor(remaining / 60000)
      const s = Math.floor((remaining % 60000) / 1000)
      setTimeLeft(`${m}m ${s.toString().padStart(2, "0")}s`)
    }
    tick()
    const id = setInterval(tick, 1000)
    return () => clearInterval(id)
  }, [expiresAt])

  useEffect(() => {
    if (!polling) return
    const id = setInterval(async () => {
      const r = await fetch("/api/pipeline")
      const d = await r.json()
      if (d.status === "completed") {
        setPhase("scraped")
        setItems(d.results?.items || [])
        setPolling(false)
        autoUpload(d.results?.items || [])
      } else if (d.status === "error") {
        setPhase("idle")
        setError(d.error)
        setPolling(false)
      }
    }, 3000)
    return () => clearInterval(id)
  }, [polling])

  const autoUpload = async (scrapeItems: ScrapeItem[]) => {
    setPhase("uploading")
    setError(null)
    const r = await fetch("/api/pipeline", {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ items: scrapeItems, query }),
    })
    const d = await r.json()
    if (d.error) { setPhase("scraped"); setError(d.error) }
    else { setPhase("summarized"); setSummary(d.summary); loadData() }
  }

  const triggerScrape = async () => {
    setPhase("scraping")
    setError(null)
    setItems([])
    setSummary(null)
    const r = await fetch("/api/pipeline", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ query }),
    })
    const d = await r.json()
    if (d.error) { setPhase("idle"); setError(d.error) }
    else setPolling(true)
  }

  const submitToken = async () => {
    if (!boxToken.trim()) return
    setTokenError("")
    const r = await fetch("/api/pipeline", {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ token: boxToken }),
    })
    const d = await r.json()
    if (!r.ok) { setTokenError(d.error || "Invalid token"); return }
    if (d.expiresAt) setExpiresAt(d.expiresAt)
    setTokenSet(true)
    setBoxToken("")
    loadData()
  }

  // Token gate
  if (!tokenSet) {
    return (
      <div className="flex h-svh flex-col items-center justify-center bg-background text-foreground">
        <div className="w-full max-w-md space-y-4 px-6">
          <div className="flex items-center gap-3">
            <Key size={24} className="text-muted-foreground" />
            <h1 className="text-sm font-medium uppercase tracking-[0.18em]">Box Developer Token Required</h1>
          </div>
          <p className="text-xs leading-relaxed text-muted-foreground">
            The pipeline needs a Box Developer Token to store scraped data and run AI summaries. Tokens expire every 60 minutes.
          </p>
          <div className="rounded border border-border/60 bg-card p-4 space-y-3">
            <Input
              value={boxToken}
              onChange={e => setBoxToken(e.target.value)}
              placeholder="Paste your Box Developer Token..."
              className="text-xs"
              onKeyDown={e => e.key === "Enter" && submitToken()}
            />
            <Button size="sm" className="w-full" disabled={!boxToken.trim()} onClick={submitToken}>
              Connect to Box
            </Button>
            {tokenError && <p className="text-xs text-red-400">{tokenError}</p>}
          </div>
          <button onClick={() => setShowInfo(!showInfo)} className="flex items-center gap-1 text-[10px] text-muted-foreground hover:text-foreground transition">
            <Info size={12} /> How to get a token
          </button>
          {showInfo && (
            <div className="rounded border border-border/60 bg-card p-3 text-xs text-muted-foreground space-y-1">
              <p>1. Go to <a href="https://app.box.com/developers/console" target="_blank" className="underline text-foreground">app.box.com/developers/console</a></p>
              <p>2. Open your app → <strong>Configuration</strong> tab</p>
              <p>3. Scroll to <strong>Developer Token</strong> → click <strong>Generate</strong></p>
              <p>4. Copy and paste it above (valid for 60 min)</p>
            </div>
          )}
          <Button variant="ghost" size="sm" className="w-full text-[10px] text-muted-foreground" onClick={() => setTokenSet(true)}>
            Skip — view history only
          </Button>
        </div>
      </div>
    )
  }

  return (
    <div className="flex h-svh flex-col bg-background text-foreground">
      <header className="flex items-center justify-between border-b border-border/60 px-6 py-3">
        <h1 className="text-sm font-medium uppercase tracking-[0.18em]">Pipeline</h1>
        <div className="flex items-center gap-3">
          <button onClick={() => { setTokenSet(false); setShowInfo(false) }} className="flex items-center gap-1 text-[10px] text-muted-foreground hover:text-foreground transition">
            <Key size={10} /> Token
            {timeLeft && (
              <span className={`ml-1 ${timeLeft === "expired" ? "text-red-400" : "text-green-400"}`}>
                ({timeLeft})
              </span>
            )}
          </button>
          <div className="flex items-center gap-2 text-[10px] uppercase tracking-[0.18em] text-muted-foreground">
            <span>Apify</span><ArrowRight size={10} /><span>Box</span><ArrowRight size={10} /><span>Box AI</span><ArrowRight size={10} /><span>Stored</span>
          </div>
        </div>
      </header>

      <div className="flex min-h-0 flex-1">
        {/* Column 1: Scrape */}
        <div className="flex w-1/2 flex-col border-r border-border/60">
          <div className="border-b border-border/60 px-4 py-3">
            <div className="flex items-center gap-2">
              <Newspaper size={14} className="text-muted-foreground" />
              <span className="text-[10px] font-medium uppercase tracking-[0.18em] text-muted-foreground">1. Scrape</span>
            </div>
          </div>
          <div className="flex-1 overflow-y-auto p-4">
            <div className="mb-4 space-y-2">
              <Input value={query} onChange={e => setQuery(e.target.value)} placeholder="Search query..." className="text-xs" />
              <Button size="sm" className="w-full gap-2" disabled={phase === "scraping" || phase === "uploading"} onClick={triggerScrape}>
                {phase === "scraping" ? <><CircleNotch size={14} className="animate-spin" /> Scraping...</>
                  : phase === "uploading" ? <><CircleNotch size={14} className="animate-spin" /> Processing...</>
                  : <><Play size={14} /> Run Pipeline</>}
              </Button>
            </div>
            {items.length > 0 && (
              <>
                <p className="mb-2 text-[10px] uppercase tracking-[0.18em] text-muted-foreground">Results ({items.length})</p>
                <div className="space-y-1.5">
                  {items.map((item, i) => (
                    <div key={i} className="rounded border border-border/60 px-3 py-2">
                      <p className="text-xs font-medium leading-tight">{item.title}</p>
                      {item.source && <p className="mt-0.5 text-[10px] text-muted-foreground">{item.source}</p>}
                    </div>
                  ))}
                </div>
              </>
            )}
          </div>
        </div>

        {/* Column 2: World Context + History */}
        <div className="flex w-1/2 flex-col">
          <div className="border-b border-border/60 px-4 py-3">
            <div className="flex items-center gap-2">
              <Lightning size={14} className="text-muted-foreground" />
              <span className="text-[10px] font-medium uppercase tracking-[0.18em] text-muted-foreground">2. World Context</span>
            </div>
          </div>
          <div className="flex-1 overflow-y-auto p-4">
            {summary && (
              <div className="mb-4 rounded border border-green-500/30 bg-green-500/5 p-4">
                <p className="mb-1 text-[10px] uppercase tracking-[0.18em] text-green-400">✓ Latest Summary</p>
                <p className="text-sm leading-relaxed">{summary}</p>
              </div>
            )}

            {error && (
              <div className="mb-4 rounded border border-red-500/30 bg-red-500/5 p-3 text-xs text-red-400">{error}</div>
            )}

            <p className="mb-2 text-[10px] uppercase tracking-[0.18em] text-muted-foreground">History ({history.length})</p>
            {history.length === 0 ? (
              <p className="text-xs text-muted-foreground">No past events yet. Run the pipeline to generate world context.</p>
            ) : (
              <div className="space-y-2">
                {history.map(ev => (
                  <div key={ev.id} className="rounded border border-border/60 px-3 py-2">
                    <p className="text-xs leading-relaxed">{ev.summary}</p>
                    <div className="mt-1 flex items-center gap-2 text-[10px] text-muted-foreground">
                      <span>{new Date(ev.created_at).toLocaleDateString()}</span>
                      <span>·</span>
                      <span>{ev.scrape_query}</span>
                    </div>
                  </div>
                ))}
              </div>
            )}
          </div>
        </div>
      </div>
    </div>
  )
}

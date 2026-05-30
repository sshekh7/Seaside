/**
 * Supabase Edge Function: agent-daily-summary
 *
 * Generates a daily PDF summary for every agent (or a single agent if
 * agent_id is provided) and uploads it to Box under:
 *   Seaside Daily Reports / YYYY-MM-DD / agent-name-YYYY-MM-DD.pdf
 *
 * Triggered by:
 *   - pg_cron (see supabase/cron.sql) — runs nightly at 23:00 UTC
 *   - Manual POST from the Next.js UI (Authorization: Bearer <SUPABASE_ANON_KEY>)
 *
 * Request body (all optional):
 *   { agent_id?: string, date?: string }   date defaults to today (UTC)
 *
 * Required env vars (set in Supabase Dashboard → Project Settings → Edge Functions):
 *   SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY   — auto-injected by Supabase
 *   BEDROCK_REGION, BEDROCK_ACCESS_KEY_ID, BEDROCK_SECRET_ACCESS_KEY
 *   BOX_DEVELOPER_TOKEN  (dev) OR BOX_ACCESS_TOKEN (prod OAuth)
 *   BOX_FOLDER_ID        (optional, default "0" = root)
 *   CRON_SECRET          (optional bearer token check)
 */

import { createClient } from "npm:@supabase/supabase-js@2"
import {
  PDFDocument,
  StandardFonts,
  rgb,
  PageSizes,
} from "npm:pdf-lib@1"
import {
  BedrockRuntimeClient,
  InvokeModelCommand,
} from "npm:@aws-sdk/client-bedrock-runtime@3"

/* ─── Supabase client (service role — reads all agents/plans/memories) ─── */
const supabase = createClient(
  Deno.env.get("SUPABASE_URL")!,
  Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!
)

/* ─── AWS Bedrock ─── */
const bedrock = new BedrockRuntimeClient({
  region: Deno.env.get("BEDROCK_REGION") ?? "us-west-2",
  credentials: {
    accessKeyId: Deno.env.get("BEDROCK_ACCESS_KEY_ID")!,
    secretAccessKey: Deno.env.get("BEDROCK_SECRET_ACCESS_KEY")!,
  },
})

async function callClaude(system: string, user: string): Promise<string> {
  const body = JSON.stringify({
    anthropic_version: "bedrock-2023-05-31",
    max_tokens: 1024,
    temperature: 0.7,
    system,
    messages: [{ role: "user", content: user }],
  })
  const res = await bedrock.send(
    new InvokeModelCommand({
      modelId: "us.anthropic.claude-haiku-4-5-20251001-v1:0",
      contentType: "application/json",
      body: new TextEncoder().encode(body),
    })
  )
  const result = JSON.parse(new TextDecoder().decode(res.body))
  return result.content[0].text
}

/* ─── Box helpers (pure REST — no Node SDK needed) ─── */
const boxToken = () =>
  Deno.env.get("BOX_DEVELOPER_TOKEN") ?? Deno.env.get("BOX_ACCESS_TOKEN") ?? ""

async function boxGet(path: string) {
  const res = await fetch(`https://api.box.com/2.0${path}`, {
    headers: { Authorization: `Bearer ${boxToken()}` },
  })
  if (!res.ok) throw new Error(`Box GET ${path} → ${res.status}: ${await res.text()}`)
  return res.json()
}

async function boxCreateFolder(name: string, parentId: string): Promise<string> {
  const res = await fetch("https://api.box.com/2.0/folders", {
    method: "POST",
    headers: {
      Authorization: `Bearer ${boxToken()}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({ name, parent: { id: parentId } }),
  })
  if (res.status === 409) {
    // Already exists — fetch the id from the conflict body
    const body = await res.json()
    return body.context_info?.conflicts?.[0]?.id ?? ""
  }
  if (!res.ok) throw new Error(`Box createFolder ${name} → ${res.status}: ${await res.text()}`)
  const body = await res.json()
  return body.id as string
}

async function ensureBoxPath(segments: string[], rootId = Deno.env.get("BOX_FOLDER_ID") ?? "0"): Promise<string> {
  let currentId = rootId
  for (const segment of segments) {
    const items = await boxGet(`/folders/${currentId}/items?fields=id,name,type&limit=200`)
    const existing = items.entries?.find(
      (e: { type: string; name: string; id: string }) => e.type === "folder" && e.name === segment
    )
    currentId = existing ? existing.id : await boxCreateFolder(segment, currentId)
  }
  return currentId
}

async function boxUploadPdf(folderId: string, filename: string, pdfBytes: Uint8Array): Promise<string> {
  const form = new FormData()
  form.append(
    "attributes",
    JSON.stringify({ name: filename, parent: { id: folderId } })
  )
  form.append("file", new Blob([pdfBytes], { type: "application/pdf" }), filename)

  const res = await fetch("https://upload.box.com/api/2.0/files/content", {
    method: "POST",
    headers: { Authorization: `Bearer ${boxToken()}` },
    body: form,
  })
  if (!res.ok) throw new Error(`Box upload ${filename} → ${res.status}: ${await res.text()}`)
  const body = await res.json()
  return body.entries?.[0]?.id as string
}

/* ─── Narrative generation ─── */
type AgentNarrative = {
  state_of_thought: string
  train_of_thought: string
  daily_summary: string
}

type Beat = {
  start_time: string
  end_time: string
  activity: string
  location_name: string
  reasoning?: string
}

type Memory = {
  activity: string
  time_start: string
}

// deno-lint-ignore no-explicit-any
type Agent = Record<string, any>

async function generateNarrative(
  agent: Agent,
  beats: Beat[],
  memories: Memory[]
): Promise<AgentNarrative> {
  const beatLines = beats
    .map((b) => {
      const t = new Date(b.start_time).toLocaleTimeString("en-US", {
        hour: "2-digit", minute: "2-digit", hour12: true,
      })
      return `${t} – ${b.activity} @ ${b.location_name}${b.reasoning ? ` (${b.reasoning})` : ""}`
    })
    .join("\n")

  const memLines = memories
    .map((m) => {
      const t = new Date(m.time_start).toLocaleTimeString("en-US", {
        hour: "2-digit", minute: "2-digit", hour12: true,
      })
      return `• ${m.activity} (${t})`
    })
    .join("\n")

  const system = `You are a thoughtful psychologist and narrative writer summarising an AI agent's simulated day.
Write in first-person present tense as if you ARE the agent reflecting on today.`

  const user = `Agent profile:
Name: ${agent.name}
Age: ${agent.age ?? "unknown"}
Job: ${agent.job_description ?? "unknown"}
Personality: ${agent.personality ?? "average person"}
Home: ${agent.location_home ?? "Seattle"}
Work: ${agent.location_work ?? "Seattle"}

Today's planned schedule:
${beatLines || "(no plan generated yet)"}

Actual memories recorded today:
${memLines || "(no memories recorded yet)"}

Respond with ONLY a JSON object (no markdown, no code fences):
{
  "state_of_thought": "2-3 sentences: my overall emotional and cognitive state today",
  "train_of_thought": "Numbered steps 1-7 showing my internal reasoning chain through the day",
  "daily_summary": "One diary-style paragraph (4-6 sentences) summarising today"
}`

  const text = await callClaude(system, user)
  try {
    const cleaned = text.replace(/```json\s*/g, "").replace(/```/g, "").trim()
    const match = cleaned.match(/\{[\s\S]*\}/)
    if (match) return JSON.parse(match[0]) as AgentNarrative
    return JSON.parse(cleaned) as AgentNarrative
  } catch {
    return {
      state_of_thought: text.slice(0, 400),
      train_of_thought: "(parsing error)",
      daily_summary: text.slice(0, 600),
    }
  }
}

/* ─── PDF generation ─── */
const C = {
  bg:     rgb(0.020, 0.024, 0.039),
  white:  rgb(1, 1, 1),
  muted:  rgb(0.55, 0.55, 0.65),
  accent: rgb(0.882, 0.906, 0.941),
  blue:   rgb(0.376, 0.647, 0.980),
  divider:rgb(0.12, 0.14, 0.20),
}

function wrapText(
  str: string,
  // deno-lint-ignore no-explicit-any
  font: any,
  size: number,
  maxW: number
): string[] {
  const out: string[] = []
  for (const para of str.split("\n")) {
    const words = para.split(" ")
    let line = ""
    for (const w of words) {
      const cand = line ? `${line} ${w}` : w
      if (font.widthOfTextAtSize(cand, size) <= maxW) {
        line = cand
      } else {
        if (line) out.push(line)
        line = w
      }
    }
    if (line) out.push(line)
  }
  return out
}

async function buildPdf(
  agent: Agent,
  date: string,
  beats: Beat[],
  memories: Memory[],
  narrative: AgentNarrative
): Promise<Uint8Array> {
  const doc = await PDFDocument.create()
  const R = await doc.embedFont(StandardFonts.Helvetica)
  const B = await doc.embedFont(StandardFonts.HelveticaBold)
  const M = await doc.embedFont(StandardFonts.Courier)

  const [W, H] = PageSizes.Letter   // 612 × 792
  const pad = 48
  const cW = W - pad * 2

  let page = doc.addPage([W, H])
  let y = H

  const bump = (n: number) => { y -= n }

  const guard = (need: number) => {
    if (y - need < pad) {
      page = doc.addPage([W, H])
      y = H - pad
    }
  }

  const line = (
    str: string,
    // deno-lint-ignore no-explicit-any
    opts: { x?: number; size?: number; font?: any; color?: ReturnType<typeof rgb>; lh?: number } = {}
  ) => {
    const { x = pad, size = 11, font = R, color = C.accent, lh } = opts
    const h = lh ?? size * 1.4
    guard(h + 4)
    page.drawText(str, { x, y: y - h, size, font, color })
    y -= h
  }

  const block = (
    str: string,
    // deno-lint-ignore no-explicit-any
    opts: { x?: number; size?: number; font?: any; color?: ReturnType<typeof rgb>; lh?: number } = {}
  ) => {
    const { x = pad, size = 10.5, font = R, color = C.accent, lh = 16 } = opts
    for (const ln of wrapText(str, font, size, cW - (x - pad))) {
      guard(lh + 2)
      page.drawText(ln, { x, y: y - lh, size, font, color })
      y -= lh
    }
  }

  const hr = () => {
    guard(16)
    bump(6)
    page.drawLine({ start: { x: pad, y }, end: { x: W - pad, y }, thickness: 0.5, color: C.divider })
    bump(8)
  }

  const section = (label: string) => {
    bump(12)
    guard(22)
    page.drawText(label.toUpperCase(), { x: pad, y: y - 14, size: 8, font: B, color: C.blue, opacity: 0.9 })
    y -= 20
  }

  /* Header bar */
  page.drawRectangle({ x: 0, y: H - 56, width: W, height: 56, color: C.bg })
  page.drawText("SEASIDE", { x: pad, y: H - 36, size: 18, font: B, color: C.white })
  const sub = "Daily Agent Summary"
  page.drawText(sub, { x: W - pad - R.widthOfTextAtSize(sub, 10), y: H - 34, size: 10, font: R, color: C.muted })
  page.drawText(date, { x: pad, y: H - 50, size: 9, font: M, color: C.muted })
  y = H - 56 - 16

  /* Agent identity */
  page.drawText(agent.name.toUpperCase(), { x: pad, y: y - 28, size: 22, font: B, color: C.white })
  bump(36)
  const tag = [agent.age ? `Age ${agent.age}` : null, agent.job_description].filter(Boolean).join("  ·  ")
  if (tag) { page.drawText(tag, { x: pad, y: y - 14, size: 11, font: R, color: C.muted }); bump(20) }
  const loc = [agent.location_home && `Home: ${agent.location_home}`, agent.location_work && `Work: ${agent.location_work}`].filter(Boolean).join("    ")
  if (loc) { page.drawText(loc, { x: pad, y: y - 13, size: 10, font: R, color: C.muted }); bump(20) }

  hr()

  /* State of Thought */
  section("State of Thought")
  block(narrative.state_of_thought)
  bump(6); hr()

  /* Daily Timeline */
  section("Daily Timeline")
  if (beats.length === 0) {
    line("No plan generated for this date.", { size: 10, color: C.muted })
  } else {
    for (const beat of beats) {
      const s = new Date(beat.start_time).toLocaleTimeString("en-US", { hour: "2-digit", minute: "2-digit", hour12: true })
      const e = new Date(beat.end_time).toLocaleTimeString("en-US", { hour: "2-digit", minute: "2-digit", hour12: true })
      guard(36)
      page.drawText(`${s} – ${e}`, { x: pad, y: y - 14, size: 9, font: M, color: C.muted })
      page.drawText(beat.activity, { x: pad + 120, y: y - 14, size: 10, font: B, color: C.accent })
      bump(16)
      page.drawText(beat.location_name, { x: pad + 120, y: y - 12, size: 9, font: R, color: C.muted })
      bump(14)
      if (beat.reasoning) {
        for (const rl of wrapText(beat.reasoning, R, 9, cW - 120)) {
          guard(14)
          page.drawText(rl, { x: pad + 120, y: y - 12, size: 9, font: R, color: C.muted, opacity: 0.7 })
          bump(13)
        }
      }
      bump(4)
    }
  }
  hr()

  /* Train of Thought */
  section("Train of Thought")
  block(narrative.train_of_thought)
  bump(6); hr()

  /* Memory Log */
  section("Memory Log")
  if (memories.length === 0) {
    line("No memories recorded for this date.", { size: 10, color: C.muted })
  } else {
    for (const mem of memories) {
      const ts = new Date(mem.time_start).toLocaleTimeString("en-US", { hour: "2-digit", minute: "2-digit", hour12: true })
      guard(18)
      page.drawText("●", { x: pad, y: y - 12, size: 8, font: R, color: C.blue })
      page.drawText(mem.activity, { x: pad + 16, y: y - 12, size: 10, font: R, color: C.accent })
      page.drawText(ts, { x: W - pad - M.widthOfTextAtSize(ts, 9), y: y - 12, size: 9, font: M, color: C.muted })
      bump(18)
    }
  }
  hr()

  /* Day Summary */
  section("Day Summary")
  block(narrative.daily_summary)
  bump(8)

  /* Footer on every page */
  const footer = `Seaside · auto-generated · ${new Date().toISOString()}`
  const fW = M.widthOfTextAtSize(footer, 8)
  for (const [i, p] of doc.getPages().entries()) {
    p.drawText(footer, { x: (W - fW) / 2, y: 20, size: 8, font: M, color: C.muted, opacity: 0.5 })
    const pg = `${i + 1} / ${doc.getPageCount()}`
    p.drawText(pg, { x: W - pad - M.widthOfTextAtSize(pg, 8), y: 20, size: 8, font: M, color: C.muted, opacity: 0.5 })
  }

  return doc.save()
}

/* ─── Per-agent report ─── */
async function reportForAgent(agentId: string, date: string) {
  // Agent
  const { data: agent, error: aErr } = await supabase
    .from("agents").select("*").eq("id", agentId).maybeSingle()
  if (aErr || !agent) throw new Error(`Agent ${agentId} not found`)

  // Plan beats from Supabase
  const { data: planRow } = await supabase
    .from("plans").select("plan_data").eq("agent_id", agentId).eq("sim_date", date).maybeSingle()
  const beats: Beat[] = (planRow?.plan_data?.beats ?? []) as Beat[]

  // Memories for the date
  const { data: memories } = await supabase
    .from("memory").select("activity, time_start")
    .eq("agent_id", agentId)
    .gte("time_start", `${date}T00:00:00Z`)
    .lte("time_start", `${date}T23:59:59Z`)
    .order("time_start", { ascending: true })

  const mems: Memory[] = (memories ?? []) as Memory[]

  // LLM narrative
  const narrative = await generateNarrative(agent, beats, mems)

  // Build PDF
  const pdfBytes = await buildPdf(agent, date, beats, mems, narrative)

  // Box upload
  const slug = (agent.name as string).toLowerCase().replace(/\s+/g, "-")
  const folderId = await ensureBoxPath(["Seaside Daily Reports", date])
  const filename = `${slug}-${date}.pdf`
  const fileId = await boxUploadPdf(folderId, filename, pdfBytes)

  return {
    agent: agent.name,
    boxFileId: fileId,
    boxUrl: `https://app.box.com/file/${fileId}`,
    beatCount: beats.length,
    memoryCount: mems.length,
  }
}

/* ─── Entry point ─── */
Deno.serve(async (req: Request) => {
  // Optional bearer check
  const secret = Deno.env.get("CRON_SECRET")
  if (secret) {
    const auth = req.headers.get("authorization") ?? ""
    if (auth !== `Bearer ${secret}`) {
      return new Response(JSON.stringify({ error: "Unauthorized" }), {
        status: 401, headers: { "Content-Type": "application/json" },
      })
    }
  }

  let agentId: string | undefined
  let date: string | undefined
  try {
    const body = await req.json()
    agentId = body.agent_id
    date = body.date
  } catch { /* no body */ }

  const reportDate = date ?? new Date().toISOString().slice(0, 10)

  try {
    if (agentId) {
      // Single agent
      const result = await reportForAgent(agentId, reportDate)
      return new Response(JSON.stringify({ success: true, date: reportDate, ...result }), {
        headers: { "Content-Type": "application/json" },
      })
    }

    // All agents
    const { data: agents } = await supabase.from("agents").select("id, name")
    if (!agents?.length) {
      return new Response(JSON.stringify({ error: "No agents found" }), {
        status: 404, headers: { "Content-Type": "application/json" },
      })
    }

    const results = await Promise.allSettled(
      agents.map((a) => reportForAgent(a.id, reportDate))
    )

    const succeeded = results
      .filter((r): r is PromiseFulfilledResult<Awaited<ReturnType<typeof reportForAgent>>> => r.status === "fulfilled")
      .map((r) => r.value)

    const failed = results
      .filter((r): r is PromiseRejectedResult => r.status === "rejected")
      .map((r, i) => ({ agent: agents[i]?.name, error: r.reason?.message ?? "unknown" }))

    return new Response(
      JSON.stringify({ date: reportDate, total: agents.length, succeeded: succeeded.length, failed: failed.length, reports: succeeded, errors: failed }),
      { headers: { "Content-Type": "application/json" } }
    )
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err)
    console.error("[agent-daily-summary]", message)
    return new Response(JSON.stringify({ error: message }), {
      status: 500, headers: { "Content-Type": "application/json" },
    })
  }
})

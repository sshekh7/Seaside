import { NextRequest, NextResponse } from "next/server"
import { readFileSync, existsSync } from "node:fs"
import { join } from "node:path"
import { Readable } from "node:stream"
import {
  PDFDocument,
  StandardFonts,
  rgb,
  PageSizes,
} from "pdf-lib"
import { BedrockRuntimeClient, InvokeModelCommand } from "@aws-sdk/client-bedrock-runtime"
import { supabase, type Agent, type Memory, type DayPlan } from "@/lib/supabase"
import { getBoxClient, ensureBoxFolderPath } from "@/lib/box"

/* ─── AWS Bedrock ─── */
const bedrock = new BedrockRuntimeClient({
  region: process.env.BEDROCK_REGION ?? process.env.AWS_REGION ?? "us-west-2",
  credentials: {
    accessKeyId: (process.env.BEDROCK_ACCESS_KEY_ID ?? process.env.AWS_ACCESS_KEY_ID)!,
    secretAccessKey: (process.env.BEDROCK_SECRET_ACCESS_KEY ?? process.env.AWS_SECRET_ACCESS_KEY)!,
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

/* ─── LLM: generate SoT / ToT narrative ─── */
type AgentNarrative = {
  state_of_thought: string   // overall emotional/cognitive state for the day
  train_of_thought: string   // step-by-step reasoning chain through the day
  daily_summary: string      // one-paragraph human-readable summary
}

async function generateNarrative(
  agent: Agent,
  plan: DayPlan | null,
  memories: Memory[]
): Promise<AgentNarrative> {
  const beatLines = (plan?.beats ?? [])
    .map((b) => {
      const t = new Date(b.start_time).toLocaleTimeString("en-US", {
        hour: "2-digit", minute: "2-digit", hour12: true,
      })
      return `${t} – ${b.activity} @ ${b.location_name}${b.reasoning ? ` (reasoning: ${b.reasoning})` : ""}`
    })
    .join("\n")

  const memLines = memories
    .map((m) => `• ${m.activity} (${new Date(m.time_start).toLocaleTimeString("en-US", { hour: "2-digit", minute: "2-digit", hour12: true })})`)
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

Generate a JSON object (no markdown, no code fences) with exactly these three keys:
{
  "state_of_thought": "2-3 sentences capturing my overall emotional and cognitive state today — how I felt, what was on my mind, my mood arc across the day",
  "train_of_thought": "A numbered list (1. ... 2. ... 3. ...) of 5-8 steps showing my internal reasoning chain: why I made each key decision today, how I transitioned between activities, what motivated me",
  "daily_summary": "One flowing paragraph (4-6 sentences) summarising my day as a human diary entry"
}`

  const text = await callClaude(system, user)

  try {
    const cleaned = text.replace(/```json\s*/g, "").replace(/```/g, "").trim()
    const match = cleaned.match(/\{[\s\S]*\}/)
    if (match) return JSON.parse(match[0]) as AgentNarrative
    return JSON.parse(cleaned) as AgentNarrative
  } catch {
    return {
      state_of_thought: text.slice(0, 300),
      train_of_thought: "(could not parse structured output)",
      daily_summary: text.slice(0, 500),
    }
  }
}

/* ─── PDF generation ─── */

const COLORS = {
  background:   rgb(0.020, 0.024, 0.039), // #05060a
  surface:      rgb(0.059, 0.067, 0.090), // #0f1117
  white:        rgb(1, 1, 1),
  muted:        rgb(0.55, 0.55, 0.65),
  accent:       rgb(0.882, 0.906, 0.941), // #e2e8f0
  sectionLabel: rgb(0.376, 0.647, 0.980), // #60a5fa – cool blue
  divider:      rgb(0.12, 0.14, 0.20),
}

/** Wrap text into lines of at most maxWidth pt using the given font/size. */
function wrapText(text: string, font: Awaited<ReturnType<PDFDocument["embedFont"]>>, size: number, maxWidth: number): string[] {
  const lines: string[] = []
  for (const paragraph of text.split("\n")) {
    const words = paragraph.split(" ")
    let current = ""
    for (const word of words) {
      const candidate = current ? `${current} ${word}` : word
      if (font.widthOfTextAtSize(candidate, size) <= maxWidth) {
        current = candidate
      } else {
        if (current) lines.push(current)
        current = word
      }
    }
    if (current) lines.push(current)
  }
  return lines
}

/** Draw a filled rounded-rect approximation (just a rect in pdf-lib). */
function fillRect(page: ReturnType<PDFDocument["addPage"]>, x: number, y: number, w: number, h: number, color: ReturnType<typeof rgb>) {
  page.drawRectangle({ x, y, width: w, height: h, color })
}

async function buildPdf(
  agent: Agent,
  date: string,
  plan: DayPlan | null,
  memories: Memory[],
  narrative: AgentNarrative
): Promise<Uint8Array> {
  const pdfDoc = await PDFDocument.create()
  const fontRegular = await pdfDoc.embedFont(StandardFonts.Helvetica)
  const fontBold    = await pdfDoc.embedFont(StandardFonts.HelveticaBold)
  const fontMono    = await pdfDoc.embedFont(StandardFonts.Courier)

  const [pageW, pageH] = PageSizes.Letter        // 612 × 792
  const margin = 48
  const contentW = pageW - margin * 2

  let page = pdfDoc.addPage([pageW, pageH])
  let y = pageH  // cursor from top; we subtract as we go

  /** Ensure we have at least `needed` pts of space; add a new page if not. */
  const ensureSpace = (needed: number) => {
    if (y - needed < margin) {
      page = pdfDoc.addPage([pageW, pageH])
      y = pageH - margin
    }
  }

  /** Draw a line of text, return new y. */
  const text = (
    str: string,
    opts: { x?: number; size?: number; font?: typeof fontRegular; color?: ReturnType<typeof rgb>; lineH?: number } = {}
  ) => {
    const { x = margin, size = 11, font = fontRegular, color = COLORS.accent, lineH } = opts
    const lh = lineH ?? size * 1.4
    ensureSpace(lh + 4)
    page.drawText(str, { x, y: y - lh, size, font, color })
    y -= lh
    return y
  }

  /** Draw wrapped text block, return new y. */
  const textBlock = (
    str: string,
    { x = margin, size = 10.5, font = fontRegular, color = COLORS.accent, lineH = 16 } = {}
  ) => {
    const lines = wrapText(str, font, size, contentW - (x - margin))
    for (const line of lines) {
      ensureSpace(lineH + 2)
      page.drawText(line, { x, y: y - lineH, size, font, color })
      y -= lineH
    }
    return y
  }

  /** Section divider line */
  const divider = () => {
    ensureSpace(14)
    y -= 6
    page.drawLine({ start: { x: margin, y }, end: { x: pageW - margin, y }, thickness: 0.5, color: COLORS.divider })
    y -= 8
  }

  /** Section label */
  const sectionHeader = (label: string) => {
    y -= 10
    ensureSpace(22)
    page.drawText(label.toUpperCase(), {
      x: margin, y: y - 14, size: 8,
      font: fontBold, color: COLORS.sectionLabel,
      opacity: 0.9,
    })
    y -= 14
    y -= 6
  }

  /* ── DARK HEADER BAR ── */
  fillRect(page, 0, pageH - 56, pageW, 56, COLORS.background)
  // "SEASIDE" left
  page.drawText("SEASIDE", { x: margin, y: pageH - 36, size: 18, font: fontBold, color: COLORS.white })
  // "Daily Agent Summary" right
  const subLabel = "Daily Agent Summary"
  const subW = fontRegular.widthOfTextAtSize(subLabel, 10)
  page.drawText(subLabel, { x: pageW - margin - subW, y: pageH - 34, size: 10, font: fontRegular, color: COLORS.muted })
  // date line left
  page.drawText(date, { x: margin, y: pageH - 50, size: 9, font: fontMono, color: COLORS.muted })

  y = pageH - 56 - 16

  /* ── AGENT IDENTITY ── */
  // Name
  page.drawText(agent.name.toUpperCase(), {
    x: margin, y: y - 28, size: 22, font: fontBold, color: COLORS.white,
  })
  y -= 36

  const tagParts = [
    agent.age ? `Age ${agent.age}` : null,
    agent.job_description ?? null,
  ].filter(Boolean).join("  ·  ")

  if (tagParts) {
    page.drawText(tagParts, { x: margin, y: y - 14, size: 11, font: fontRegular, color: COLORS.muted })
    y -= 20
  }

  const locParts = [
    agent.location_home ? `🏠 ${agent.location_home}` : null,
    agent.location_work ? `💼 ${agent.location_work}` : null,
  ].filter(Boolean).join("    ")

  if (locParts) {
    // pdf-lib doesn't render emoji reliably; strip to text only
    const locClean = locParts.replace(/[^\x20-\x7E]/g, "")
    page.drawText(locClean, { x: margin, y: y - 13, size: 10, font: fontRegular, color: COLORS.muted })
    y -= 20
  }

  divider()

  /* ── STATE OF THOUGHT ── */
  sectionHeader("State of Thought")
  textBlock(narrative.state_of_thought, { font: fontRegular, size: 10.5, lineH: 16 })
  y -= 6
  divider()

  /* ── DAILY TIMELINE ── */
  sectionHeader("Daily Timeline")

  const beats = plan?.beats ?? []
  if (beats.length === 0) {
    text("No plan generated for this date.", { size: 10, color: COLORS.muted })
  } else {
    for (const beat of beats) {
      const startStr = new Date(beat.start_time).toLocaleTimeString("en-US", {
        hour: "2-digit", minute: "2-digit", hour12: true,
      })
      const endStr = new Date(beat.end_time).toLocaleTimeString("en-US", {
        hour: "2-digit", minute: "2-digit", hour12: true,
      })
      ensureSpace(34)

      // Time column
      page.drawText(`${startStr} – ${endStr}`, {
        x: margin, y: y - 14, size: 9, font: fontMono, color: COLORS.muted,
      })
      // Activity
      page.drawText(beat.activity, {
        x: margin + 120, y: y - 14, size: 10, font: fontBold, color: COLORS.accent,
      })
      y -= 16

      // Location
      page.drawText(beat.location_name, {
        x: margin + 120, y: y - 12, size: 9, font: fontRegular, color: COLORS.muted,
      })
      y -= 14

      // Reasoning (if present)
      if (beat.reasoning) {
        const reasonLines = wrapText(beat.reasoning, fontRegular, 9, contentW - 120)
        for (const rl of reasonLines) {
          ensureSpace(14)
          page.drawText(rl, { x: margin + 120, y: y - 12, size: 9, font: fontRegular, color: COLORS.muted, opacity: 0.7 })
          y -= 13
        }
      }

      y -= 4
    }
  }

  divider()

  /* ── TRAIN OF THOUGHT ── */
  sectionHeader("Train of Thought")
  textBlock(narrative.train_of_thought, { font: fontRegular, size: 10.5, lineH: 16 })
  y -= 6
  divider()

  /* ── MEMORY LOG ── */
  sectionHeader("Memory Log")

  if (memories.length === 0) {
    text("No memories recorded for this date.", { size: 10, color: COLORS.muted })
  } else {
    for (const mem of memories) {
      const ts = new Date(mem.time_start).toLocaleTimeString("en-US", {
        hour: "2-digit", minute: "2-digit", hour12: true,
      })
      ensureSpace(18)
      page.drawText(`●`, { x: margin, y: y - 12, size: 8, font: fontRegular, color: COLORS.sectionLabel })
      page.drawText(mem.activity, { x: margin + 16, y: y - 12, size: 10, font: fontRegular, color: COLORS.accent })
      const tsW = fontMono.widthOfTextAtSize(ts, 9)
      page.drawText(ts, { x: pageW - margin - tsW, y: y - 12, size: 9, font: fontMono, color: COLORS.muted })
      y -= 18
    }
  }

  divider()

  /* ── DAILY SUMMARY ── */
  sectionHeader("Day Summary")
  textBlock(narrative.daily_summary, { font: fontRegular, size: 10.5, lineH: 16 })
  y -= 8

  /* ── FOOTER (on every page) ── */
  const pages = pdfDoc.getPages()
  const footerText = `Seaside · auto-generated · ${new Date().toISOString()}`
  const footerW = fontMono.widthOfTextAtSize(footerText, 8)
  for (const p of pages) {
    p.drawText(footerText, {
      x: (pageW - footerW) / 2, y: 20,
      size: 8, font: fontMono, color: COLORS.muted, opacity: 0.5,
    })
    const pNumStr = `${pages.indexOf(p) + 1} / ${pages.length}`
    const pNumW = fontMono.widthOfTextAtSize(pNumStr, 8)
    p.drawText(pNumStr, { x: pageW - margin - pNumW, y: 20, size: 8, font: fontMono, color: COLORS.muted, opacity: 0.5 })
  }

  return pdfDoc.save()
}

/* ─── Route handler ─── */

export async function POST(req: NextRequest) {
  try {
    const body = await req.json()
    const { agent_id, date } = body as { agent_id?: string; date?: string }

    if (!agent_id) {
      return NextResponse.json({ error: "agent_id is required" }, { status: 400 })
    }

    const reportDate = date ?? new Date().toISOString().slice(0, 10)

    /* 1 – Fetch agent */
    const { data: agent, error: agentErr } = await supabase
      .from("agents")
      .select("*")
      .eq("id", agent_id)
      .maybeSingle()

    if (agentErr || !agent) {
      return NextResponse.json({ error: "Agent not found" }, { status: 404 })
    }

    /* 2 – Fetch memories for the date */
    const dayStart = `${reportDate}T00:00:00.000Z`
    const dayEnd   = `${reportDate}T23:59:59.999Z`

    const { data: memories } = await supabase
      .from("memory")
      .select("*")
      .eq("agent_id", agent_id)
      .gte("time_start", dayStart)
      .lte("time_start", dayEnd)
      .order("time_start", { ascending: true })

    /* 3 – Load day plan JSON from filesystem (if present) */
    const slug = agent.name.toLowerCase().replace(/\s+/g, "-")
    const planPath = join(process.cwd(), "experiments", "output", "plans", `${reportDate}-${slug}.json`)
    let plan: DayPlan | null = null

    if (existsSync(planPath)) {
      try {
        plan = JSON.parse(readFileSync(planPath, "utf-8")) as DayPlan
      } catch {
        // continue without plan
      }
    }

    /* 4 – Generate SoT / ToT narrative via Claude */
    const narrative = await generateNarrative(agent as Agent, plan, (memories ?? []) as Memory[])

    /* 5 – Build PDF */
    const pdfBytes = await buildPdf(agent as Agent, reportDate, plan, (memories ?? []) as Memory[], narrative)

    /* 6 – Upload to Box */
    const boxClient = getBoxClient()
    const folderPath = ["Seaside Daily Reports", reportDate]
    const folderId = await ensureBoxFolderPath(boxClient, folderPath)

    const filename = `${slug}-${reportDate}.pdf`
    const stream = Readable.from(Buffer.from(pdfBytes))
    const uploaded = await boxClient.files.uploadFile(folderId, filename, stream)
    const file = uploaded.entries[0]

    return NextResponse.json({
      success: true,
      agent: { id: agent.id, name: agent.name },
      date: reportDate,
      boxFileId: file.id,
      boxFileName: file.name,
      boxUrl: `https://app.box.com/file/${file.id}`,
      beatCount: plan?.beats?.length ?? 0,
      memoryCount: (memories ?? []).length,
    })
  } catch (err: unknown) {
    const message = err instanceof Error ? err.message : "Unknown error"
    console.error("[daily-summary]", message)
    return NextResponse.json({ error: message }, { status: 500 })
  }
}

// Diary + thought_process LLM call. Takes the finalized beats and produces
// two strings: a first-person diary (~150 words) and a longer thought_process
// paragraph.

import { completeJson } from "./llm"
import type { AgentRow, Beat } from "./types"

const SYSTEM = `You write reflective first-person prose for a fictional human agent in a city-simulation. \
You output ONLY a JSON object with two string fields: "diary" and "thought_process".

- "diary": ~150 words, first person, casual diary tone. Mention specific places and moments from the day. \
  Do NOT enumerate every beat; let it breathe. End with a feeling.
- "thought_process": one paragraph (~120 words), first person, your internal reasoning across the day. \
  Why did you choose certain things? Did world events affect you? Did your mood shift?`

export async function generateDiary(args: {
  agent: AgentRow
  simDate: string
  worldEventPrompt: string
  beats: Beat[]
}): Promise<{ diary: string; thought_process: string }> {
  const beatList = args.beats
    .map((b) => {
      const start = new Date(b.start_time).toLocaleTimeString("en-US", { hour: "numeric", minute: "2-digit" })
      const end = new Date(b.end_time).toLocaleTimeString("en-US", { hour: "numeric", minute: "2-digit" })
      return `${start}-${end} [${b.activity_type}] ${b.activity} @ ${b.location_name}`
    })
    .join("\n")

  const user = `AGENT: ${args.agent.name} (${args.agent.age ?? "?"}), ${args.agent.job_description ?? "unknown job"}.
DATE: ${args.simDate}
WORLD EVENTS TODAY: ${args.worldEventPrompt || "(none)"}

TODAY'S BEATS:
${beatList}

Write the diary + thought_process JSON now.`

  return await completeJson<{ diary: string; thought_process: string }>({
    system: SYSTEM,
    user,
    maxTokens: 800,
    temperature: 0.85,
  })
}

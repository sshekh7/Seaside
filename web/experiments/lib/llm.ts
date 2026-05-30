// LLM provider abstraction. Azure OpenAI for now; Bedrock later. Handles:
//   - chat completion w/ retry
//   - JSON object response_format
//   - cumulative latency tracking

import OpenAI from "openai"

const ENDPOINT = process.env.AZURE_OPENAI_ENDPOINT!
const API_KEY = process.env.AZURE_OPENAI_API_KEY!
const MODEL = process.env.AZURE_OPENAI_DEPLOYMENT!

if (!ENDPOINT || !API_KEY || !MODEL) {
  throw new Error("AZURE_OPENAI_ENDPOINT / API_KEY / DEPLOYMENT missing")
}

const client = new OpenAI({ baseURL: ENDPOINT, apiKey: API_KEY })

let totalMs = 0
export function getLlmMs() {
  return totalMs
}
export function resetLlmMs() {
  totalMs = 0
}

type Opts = {
  system: string
  user: string
  jsonMode?: boolean
  maxTokens?: number
  temperature?: number
  attempts?: number
}

async function sleep(ms: number) {
  return new Promise((r) => setTimeout(r, ms))
}

export async function complete(opts: Opts): Promise<string> {
  const max = opts.attempts ?? 3
  let lastErr: unknown
  for (let i = 0; i < max; i++) {
    try {
      const t0 = Date.now()
      const res = await client.chat.completions.create({
        model: MODEL,
        messages: [
          { role: "system", content: opts.system },
          { role: "user", content: opts.user },
        ],
        ...(opts.jsonMode ? { response_format: { type: "json_object" } } : {}),
        ...(opts.maxTokens ? { max_completion_tokens: opts.maxTokens } : {}),
        ...(opts.temperature != null ? { temperature: opts.temperature } : {}),
      })
      totalMs += Date.now() - t0
      const text = res.choices[0]?.message?.content
      if (!text) throw new Error("empty completion")
      return text
    } catch (err) {
      lastErr = err
      const delay = 1000 * Math.pow(2, i)
      console.warn(`[llm] attempt ${i + 1}/${max} failed:`, (err as Error).message, `retrying in ${delay}ms`)
      await sleep(delay)
    }
  }
  throw lastErr
}

export async function completeJson<T>(opts: Opts): Promise<T> {
  const text = await complete({ ...opts, jsonMode: true })
  try {
    return JSON.parse(text) as T
  } catch (err) {
    // Recovery: extract the largest {...} or [...] block
    const m = text.match(/[\[{][\s\S]*[\]}]/)
    if (m) {
      try {
        return JSON.parse(m[0]) as T
      } catch {
        /* fall through */
      }
    }
    throw new Error(`LLM did not return valid JSON: ${(err as Error).message}\nraw: ${text.slice(0, 500)}`)
  }
}

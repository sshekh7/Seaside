// LLM provider abstraction. Supports AWS Bedrock (Claude Haiku 4.5) and Azure OpenAI.
//   - chat completion w/ retry
//   - JSON object response_format
//   - cumulative latency tracking
//
// Select provider via LLM_PROVIDER env ("bedrock" default, or "azure").
// Running two sims with different providers lets you double throughput without
// sharing a single quota.

import { BedrockRuntimeClient, InvokeModelCommand } from "@aws-sdk/client-bedrock-runtime"

const PROVIDER = (process.env.LLM_PROVIDER || "bedrock").toLowerCase()

const client = new BedrockRuntimeClient({
  region: process.env.BEDROCK_REGION || process.env.AWS_REGION || "us-west-2",
  credentials: {
    accessKeyId: process.env.BEDROCK_ACCESS_KEY_ID || process.env.AWS_ACCESS_KEY_ID!,
    secretAccessKey: process.env.BEDROCK_SECRET_ACCESS_KEY || process.env.AWS_SECRET_ACCESS_KEY!,
  },
})

const MODEL = "us.anthropic.claude-haiku-4-5-20251001-v1:0"

// Azure OpenAI config. Endpoint already includes the /openai/v1/ base path.
const AZURE_ENDPOINT = (process.env.AZURE_OPENAI_ENDPOINT || "").trim().replace(/\/+$/, "")
const AZURE_API_KEY = process.env.AZURE_OPENAI_API_KEY || ""
const AZURE_DEPLOYMENT = process.env.AZURE_OPENAI_DEPLOYMENT || "gpt-5.4-nano"

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

async function callBedrock(opts: Opts): Promise<string> {
  const body = JSON.stringify({
    anthropic_version: "bedrock-2023-05-31",
    max_tokens: opts.maxTokens || 4096,
    temperature: opts.temperature ?? 0.7,
    system: opts.system,
    messages: [{ role: "user", content: opts.user }],
  })

  const command = new InvokeModelCommand({
    modelId: MODEL,
    contentType: "application/json",
    body: new TextEncoder().encode(body),
  })

  const response = await client.send(command)
  const result = JSON.parse(new TextDecoder().decode(response.body))
  const text = result.content?.[0]?.text
  if (!text) throw new Error("empty completion")
  return text
}

async function callAzure(opts: Opts): Promise<string> {
  if (!AZURE_ENDPOINT) throw new Error("AZURE_OPENAI_ENDPOINT not set")
  if (!AZURE_API_KEY) throw new Error("AZURE_OPENAI_API_KEY not set")

  const url = `${AZURE_ENDPOINT}/chat/completions`
  const payload: Record<string, unknown> = {
    model: AZURE_DEPLOYMENT,
    max_completion_tokens: opts.maxTokens || 4096,
    messages: [
      { role: "system", content: opts.system },
      { role: "user", content: opts.user },
    ],
  }
  if (opts.jsonMode) payload.response_format = { type: "json_object" }
  // gpt-5 family only supports default temperature; omit unless explicitly non-default.
  if (opts.temperature !== undefined) payload.temperature = opts.temperature

  const res = await fetch(url, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "api-key": AZURE_API_KEY,
    },
    body: JSON.stringify(payload),
  })

  if (!res.ok) {
    const errText = await res.text().catch(() => "")
    if (res.status === 429) throw new Error(`Too many requests (azure 429): ${errText.slice(0, 200)}`)
    throw new Error(`azure ${res.status}: ${errText.slice(0, 300)}`)
  }

  const result = await res.json()
  const text = result.choices?.[0]?.message?.content
  if (!text) throw new Error("empty completion")
  return text
}

export async function complete(opts: Opts): Promise<string> {
  const max = opts.attempts ?? 3
  let lastErr: unknown
  for (let i = 0; i < max; i++) {
    try {
      const t0 = Date.now()
      const text = PROVIDER === "azure" ? await callAzure(opts) : await callBedrock(opts)
      totalMs += Date.now() - t0
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
    // Recovery: strip markdown and extract JSON block
    const cleaned = text.replace(/```json?\s*/g, "").replace(/```/g, "").trim()
    const m = cleaned.match(/[\[{][\s\S]*[\]}]/)
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

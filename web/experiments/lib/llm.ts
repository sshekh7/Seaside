// LLM provider abstraction. Uses AWS Bedrock (Claude Haiku 4.5).
//   - chat completion w/ retry
//   - JSON object response_format
//   - cumulative latency tracking

import { BedrockRuntimeClient, InvokeModelCommand } from "@aws-sdk/client-bedrock-runtime"

const client = new BedrockRuntimeClient({
  region: process.env.BEDROCK_REGION || process.env.AWS_REGION || "us-west-2",
  credentials: {
    accessKeyId: process.env.BEDROCK_ACCESS_KEY_ID || process.env.AWS_ACCESS_KEY_ID!,
    secretAccessKey: process.env.BEDROCK_SECRET_ACCESS_KEY || process.env.AWS_SECRET_ACCESS_KEY!,
  },
})

const MODEL = "us.anthropic.claude-haiku-4-5-20251001-v1:0"

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
      totalMs += Date.now() - t0
      const text = result.content?.[0]?.text
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

// Minimal hello-world to confirm Azure OpenAI is reachable with the v1 endpoint
// and our deployment name. Run with: bun run experiments/00-hello.ts
import "dotenv/config"
import OpenAI from "openai"

const endpoint = process.env.AZURE_OPENAI_ENDPOINT!
const apiKey = process.env.AZURE_OPENAI_API_KEY!
const model = process.env.AZURE_OPENAI_DEPLOYMENT!

const client = new OpenAI({ baseURL: endpoint, apiKey })

const t0 = Date.now()
const res = await client.chat.completions.create({
  model,
  messages: [
    { role: "system", content: "You are a terse assistant." },
    { role: "user", content: "Say hello in 5 words." },
  ],
})
const ms = Date.now() - t0
console.log("model:", model)
console.log("latency:", ms, "ms")
console.log("choice:", JSON.stringify(res.choices[0], null, 2))

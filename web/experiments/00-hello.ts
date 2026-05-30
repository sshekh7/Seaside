// Minimal hello-world to confirm Bedrock is reachable.
// Run with: bun run experiments/00-hello.ts
import "dotenv/config"
import { complete } from "./lib/llm"

const t0 = Date.now()
const res = await complete({
  system: "You are a terse assistant.",
  user: "Say hello in 5 words.",
})
const ms = Date.now() - t0
console.log("model: Claude Haiku 4.5 (Bedrock)")
console.log("latency:", ms, "ms")
console.log("response:", res)

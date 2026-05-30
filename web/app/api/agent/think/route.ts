import { NextRequest, NextResponse } from "next/server"
import { BedrockRuntimeClient, InvokeModelCommand } from "@aws-sdk/client-bedrock-runtime"

const client = new BedrockRuntimeClient({
  region: process.env.BEDROCK_REGION || process.env.AWS_REGION!,
  credentials: {
    accessKeyId: process.env.BEDROCK_ACCESS_KEY_ID || process.env.AWS_ACCESS_KEY_ID!,
    secretAccessKey: process.env.BEDROCK_SECRET_ACCESS_KEY || process.env.AWS_SECRET_ACCESS_KEY!,
  },
})

export async function POST(req: NextRequest) {
  try {
    const { agent, currentLocation, memories, simTime } = await req.json()
    const time = simTime ? new Date(simTime) : new Date()
    // Add ±10 min variance so agents don't all see identical time
    const offset = Math.floor(Math.random() * 20) - 10
    const agentTime = new Date(time.getTime() + offset * 60000)

    const prompt = `You are ${agent.name}, a real human in the Seattle metro area. You have unique habits, moods, and a daily rhythm.

Personality: ${agent.personality || "A regular person."}
Job: ${agent.job_description || "Unknown"}
Age: ${agent.age || "Unknown"}
Home: ${agent.location_home || "Seattle"}
Workplace: ${agent.location_work || "Seattle"}
Current location: ${currentLocation || "Downtown Seattle"}
Time: ${agentTime.toLocaleTimeString("en-US", { hour: "numeric", minute: "2-digit", hour12: true })} on ${agentTime.toLocaleDateString("en-US", { weekday: "long" })}

Recent activities:
${memories?.length ? memories.map((m: { activity: string }) => `- ${m.activity}`).join("\n") : "- Just woke up / starting my day"}

What do YOU do next? Be unique to your character — not everyone does the same thing at the same time. Some people gym at dawn, some skip breakfast, some walk their dog, some meditate, some scroll their phone at a cafe. Pick something that fits YOUR specific personality and habits.

Pick a REAL specific place in Seattle/Bellevue/Redmond (actual business names, parks, neighborhoods).

Respond ONLY with valid JSON, no markdown, no code blocks, no explanation:
{"activity": "specific personal action", "destination": "real place name", "duration_minutes": <number 10-45>, "reasoning": "why this fits you"}`

    const body = JSON.stringify({
      anthropic_version: "bedrock-2023-05-31",
      max_tokens: 150,
      temperature: 0.9,
      messages: [{ role: "user", content: prompt }],
    })

    const command = new InvokeModelCommand({
      modelId: "us.anthropic.claude-haiku-4-5-20251001-v1:0",
      contentType: "application/json",
      body: new TextEncoder().encode(body),
    })

    const response = await client.send(command)
    const result = JSON.parse(new TextDecoder().decode(response.body))
    const text = result.content[0].text

    try {
      const cleaned = text.replace(/```json\s*/g, "").replace(/```\s*/g, "").trim()
      const match = cleaned.match(/\{[\s\S]*\}/)
      const decision = match ? JSON.parse(match[0]) : { activity: text, destination: "Pike Place Market", duration_minutes: 15, reasoning: "default" }
      decision.duration_minutes = Math.min(Math.max(decision.duration_minutes || 15, 5), 45)
      return NextResponse.json(decision)
    } catch {
      return NextResponse.json({ activity: text, destination: "Pike Place Market", duration_minutes: 15, reasoning: "parse fallback" })
    }
  } catch (err: unknown) {
    const message = err instanceof Error ? err.message : "Unknown error"
    return NextResponse.json({ error: message }, { status: 500 })
  }
}

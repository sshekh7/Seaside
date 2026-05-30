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

  const prompt = `You are ${agent.name}, a person living in the Seattle metro area.

Your personality: ${agent.personality || "A regular person going about their day."}
Your job: ${agent.job_description || "Unknown"}
Your age: ${agent.age || "Unknown"}
Your home: ${agent.location_home || "Seattle"}
Your workplace: ${agent.location_work || "Seattle"}

Current location: ${currentLocation || "Downtown Seattle"}
Current time: ${time.toLocaleTimeString("en-US", { hour: "numeric", minute: "2-digit", hour12: true })} on ${time.toLocaleDateString("en-US", { weekday: "long" })}

Recent memories:
${memories?.length ? memories.map((m: { activity: string }) => `- ${m.activity}`).join("\n") : "- No recent memories"}

Based on your personality, job, and the current time, decide what to do next. Consider realistic human behavior:
- People sleep at night (typically 10pm-7am at home)
- People work during business hours (9am-5pm at their workplace)
- People eat meals (breakfast, lunch, dinner)
- People run errands, socialize, exercise, relax

Respond in JSON:
{"activity": "brief description of what you're doing", "destination": "specific place name in Seattle/Bellevue/Redmond area", "duration_minutes": number (how long you'll stay there, e.g. 480 for sleeping, 60 for lunch, 30 for coffee), "reasoning": "one sentence why"}`

  const body = JSON.stringify({
    anthropic_version: "bedrock-2023-05-31",
    max_tokens: 200,
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

  // Parse JSON from response
  try {
    const match = text.match(/\{[\s\S]*\}/)
    const decision = match ? JSON.parse(match[0]) : { activity: text, destination: "Pike Place Market", reasoning: "default" }
    return NextResponse.json(decision)
  } catch {
    return NextResponse.json({ activity: text, destination: "Pike Place Market", reasoning: "parse fallback" })
  }
  } catch (err: unknown) {
    const message = err instanceof Error ? err.message : "Unknown error"
    return NextResponse.json({ error: message }, { status: 500 })
  }
}

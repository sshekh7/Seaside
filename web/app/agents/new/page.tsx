"use client"

import dynamic from "next/dynamic"
import * as React from "react"
import { useRouter } from "next/navigation"
import {
  ArrowsClockwise,
  User,
} from "@phosphor-icons/react/dist/ssr"
import { genConfig } from "react-nice-avatar"
import type { AvatarFullConfig, NiceAvatarProps } from "react-nice-avatar"

import { Button } from "@/components/ui/button"
import { Card } from "@/components/ui/card"
import { Field, FieldDescription, FieldLabel } from "@/components/ui/field"
import { Input } from "@/components/ui/input"
import { Textarea } from "@/components/ui/textarea"
import { cn } from "@/lib/utils"
import { supabase } from "@/lib/supabase"

const Avatar = dynamic(() => import("react-nice-avatar"), {
  ssr: false,
  loading: () => <div className="size-full animate-pulse bg-muted/40" />,
}) as React.ComponentType<NiceAvatarProps>

const PERSONALITY_PRESETS = [
  { label: "☕ Workaholic", value: "Intense and driven. In the office early, eats lunch at desk, gym after work. Tracks everything, optimizes routines. Rarely socializes on weekdays." },
  { label: "🎨 Creative", value: "Free-spirited night owl. Works from coffee shops, collects vinyl, goes to art shows and underground music venues. Skateboards or bikes everywhere." },
  { label: "🧘 Mindful", value: "Calm and intentional. Early riser, morning yoga or meditation, smoothie bowls, nature walks. Avoids screens before noon. Journals daily." },
  { label: "🎉 Social", value: "Extroverted and energetic. Always meeting friends, trying new restaurants, attending events. Knows every bartender in the neighborhood." },
  { label: "📚 Homebody", value: "Quiet and routine-oriented. Prefers staying in, cooking meals, reading, gardening. Goes to the library and farmers market on weekends." },
  { label: "🏃 Fitness", value: "Disciplined athlete. 5 AM runs, meal prep Sundays, tracks macros. Spends evenings at the gym or on trails. Early to bed." },
  { label: "🎮 Night Owl", value: "Sleeps late, stays up gaming or coding side projects. Lives on energy drinks and takeout. Skips morning classes/meetings when possible." },
  { label: "💼 Networker", value: "Always hustling. Power walks between meetings, lunches at upscale spots, calls clients constantly. Drives everywhere, never sits still." },
  { label: "🎓 Broke Student", value: "Perpetually broke college student. Survives on ramen and free campus food. Studies at the library until late, takes the bus everywhere. Works part-time shifts between classes. Splurges only on boba." },
  { label: "🛒 Gig Worker", value: "Hustles between DoorDash, Uber, and odd jobs. No fixed schedule — works when the surge pricing hits. Eats at gas stations, sleeps in late, always on the phone checking earnings." },
  { label: "🏕️ Unhoused", value: "Lives in a tent near the freeway. Wakes early to get to the shelter for breakfast. Spends days at the library for warmth and wifi. Visits the food bank, collects cans. Avoids certain streets at night." },
  { label: "👶 Single Parent", value: "Exhausted but loving. Drops kids at school, works a shift, picks them up, cooks dinner, helps with homework. No time for self. Grocery shops on a tight budget. Falls asleep on the couch." },
]

export default function NewAgentPage() {
  const router = useRouter()
  const [name, setName] = React.useState("")
  const [personality, setPersonality] = React.useState("")
  const [jobDescription, setJobDescription] = React.useState("")
  const [locationWork, setLocationWork] = React.useState("")
  const [locationHome, setLocationHome] = React.useState("")
  const [age, setAge] = React.useState("")
  const [config, setConfig] = React.useState<AvatarFullConfig>(() => genConfig())
  const [saving, setSaving] = React.useState(false)
  const [generating, setGenerating] = React.useState(false)
  const [genStep, setGenStep] = React.useState(0)
  const canvasRef = React.useRef<HTMLCanvasElement>(null)

  // Three.js pulsating sphere
  React.useEffect(() => {
    if (!generating || !canvasRef.current) return
    const THREE = require("three")
    const canvas = canvasRef.current
    const scene = new THREE.Scene()
    const camera = new THREE.PerspectiveCamera(50, 1, 0.1, 100)
    camera.position.z = 3
    const renderer = new THREE.WebGLRenderer({ canvas, antialias: true, alpha: true })
    renderer.setSize(256, 256)
    renderer.setPixelRatio(2)

    const geo = new THREE.SphereGeometry(1, 64, 64)
    const positions = geo.attributes.position
    const mat = new THREE.PointsMaterial({ color: 0xffffff, size: 0.015, sizeAttenuation: true })
    const points = new THREE.Points(geo, mat)
    scene.add(points)

    const basePositions = Float32Array.from(positions.array)
    let t = 0
    let raf = 0
    const animate = () => {
      t += 0.012
      const pulse = 1 + Math.sin(t * 1.2) * 0.15
      const arr = positions.array as Float32Array
      for (let i = 0; i < arr.length; i += 3) {
        const bx = basePositions[i], by = basePositions[i+1], bz = basePositions[i+2]
        // Sharp spiky noise
        const n1 = Math.sin(bx * 8 + t * 2) * Math.cos(by * 6 + t * 1.5) * Math.sin(bz * 7 + t * 1.8)
        const n2 = Math.sin(bx * 12 + t * 3) * Math.sin(bz * 10 - t * 2)
        const spike = Math.max(0, n1 * 0.4 + n2 * 0.2)
        const scale = pulse + spike
        arr[i] = bx * scale
        arr[i+1] = by * scale
        arr[i+2] = bz * scale
      }
      positions.needsUpdate = true
      points.rotation.y = t * 0.3
      points.rotation.x = Math.sin(t * 0.15) * 0.15
      renderer.render(scene, camera)
      raf = requestAnimationFrame(animate)
    }
    animate()
    return () => { cancelAnimationFrame(raf); renderer.dispose() }
  }, [generating])

  const reroll = React.useCallback(() => {
    setConfig(genConfig())
  }, [])

  const canDeploy = name.trim().length > 0

  const handleCreate = async () => {
    if (!canDeploy) return
    setSaving(true)
    const { data, error } = await supabase.from("agents").insert({
      name: name.trim(),
      profile_pic: config,
      job_description: jobDescription.trim() || null,
      location_work: locationWork.trim() || null,
      location_home: locationHome.trim() || null,
      age: age ? parseInt(age) : null,
      personality: personality.trim() || null,
    }).select("id").single()
    setSaving(false)
    if (error) {
      alert("Failed to create agent: " + error.message)
      return
    }
    if (data?.id) {
      setGenerating(true)
      const steps = [
        "Analyzing personality profile...",
        "Building daily routines...",
        "Mapping commute patterns...",
        "Generating social behaviors...",
        "Planning weekly schedule...",
        "Geocoding locations...",
        "Computing walking routes...",
        "Finalizing 7-day simulation...",
      ]
      const interval = setInterval(() => {
        setGenStep((s) => (s + 1) % steps.length)
      }, 2000)

      fetch("/api/agent/generate-plan", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ agent_id: data.id }),
      })

      // Wait a bit then redirect (plans generate in background)
      setTimeout(() => {
        clearInterval(interval)
        router.push("/map")
      }, 12000)
    } else {
      router.push("/map")
    }
  }

  const genSteps = [
    "Analyzing personality profile...",
    "Building daily routines...",
    "Mapping commute patterns...",
    "Generating social behaviors...",
    "Planning weekly schedule...",
    "Geocoding locations...",
    "Computing walking routes...",
    "Finalizing 7-day simulation...",
  ]

  if (generating) {
    return (
      <main className="relative flex min-h-svh flex-col items-center justify-center overflow-hidden bg-[#05060a] text-foreground">
        {/* Pulsating sphere using same point-cloud aesthetic */}
        <div className="relative flex items-center justify-center">
          <canvas ref={canvasRef} className="size-64" />
        </div>

        <div className="mt-8 flex flex-col items-center gap-3">
          <p className="text-sm font-medium tracking-wide text-white/80">{genSteps[genStep]}</p>
          <div className="h-[2px] w-40 overflow-hidden rounded-full bg-white/10">
            <div className="h-full rounded-full bg-white/70 transition-all duration-1000 ease-out" style={{ width: `${((genStep + 1) / genSteps.length) * 100}%` }} />
          </div>
          <p className="mt-2 text-xs uppercase tracking-[0.2em] text-white/30">{name}</p>
        </div>
      </main>
    )
  }

  return (
    <main className="flex min-h-svh flex-col bg-background text-foreground">
      <Header />

      <div className="flex-1 px-8 py-8">
        <div className="mx-auto grid w-full max-w-5xl grid-cols-1 gap-6 lg:grid-cols-[360px_1fr]">
          <Card className="gap-6 p-5">
            <SectionLabel icon={User}>Avatar</SectionLabel>

            <div className="relative mx-auto aspect-square w-full max-w-[260px]">
              <Corners />
              <div className="absolute inset-3 overflow-hidden rounded-2xl bg-muted/30">
                <Avatar
                  style={{ width: "100%", height: "100%" }}
                  shape="square"
                  {...config}
                />
              </div>
            </div>

            <Button
              variant="outline"
              size="sm"
              onClick={reroll}
              className="w-full"
            >
              <ArrowsClockwise size={14} />
              Randomize
            </Button>
          </Card>

          <Card className="gap-6 p-5">
            <SectionLabel>Details</SectionLabel>

            <Field>
              <FieldLabel>Name</FieldLabel>
              <Input
                value={name}
                onChange={(e) => setName(e.target.value)}
                placeholder="Give your agent a name"
              />
            </Field>

            <Field>
              <FieldLabel>Age</FieldLabel>
              <Input
                type="number"
                value={age}
                onChange={(e) => setAge(e.target.value)}
                placeholder="28"
              />
            </Field>

            <Field>
              <FieldLabel>Job Description</FieldLabel>
              <Input
                value={jobDescription}
                onChange={(e) => setJobDescription(e.target.value)}
                placeholder="Software engineer at a startup"
              />
            </Field>

            <Field>
              <FieldLabel>Home Location</FieldLabel>
              <Input
                value={locationHome}
                onChange={(e) => setLocationHome(e.target.value)}
                placeholder="Capitol Hill, Seattle"
              />
            </Field>

            <Field>
              <FieldLabel>Work Location</FieldLabel>
              <Input
                value={locationWork}
                onChange={(e) => setLocationWork(e.target.value)}
                placeholder="South Lake Union, Seattle"
              />
            </Field>

            <Field>
              <FieldLabel>Personality</FieldLabel>
              <div className="mb-2 flex flex-wrap gap-1.5">
                {PERSONALITY_PRESETS.map((p) => (
                  <button
                    key={p.label}
                    type="button"
                    onClick={() => setPersonality(p.value)}
                    className={cn(
                      "rounded-md border px-2 py-1 text-[11px] transition",
                      personality === p.value
                        ? "border-primary bg-primary/10 text-primary"
                        : "border-border/60 text-muted-foreground hover:border-foreground/30 hover:text-foreground"
                    )}
                  >
                    {p.label}
                  </button>
                ))}
              </div>
              <Textarea
                value={personality}
                onChange={(e) => setPersonality(e.target.value)}
                placeholder="Or write your own personality description..."
                rows={4}
              />
              <FieldDescription>
                Pick a preset or write your own. Used as the system prompt for this agent.
              </FieldDescription>
            </Field>

            <div className="flex items-center justify-end gap-2 border-t border-border/60 pt-4">
              <Button variant="ghost" size="sm" onClick={() => router.push("/map")}>
                Cancel
              </Button>
              <Button size="sm" disabled={!canDeploy || saving} onClick={handleCreate}>
                {saving ? "Creating…" : "Create agent"}
              </Button>
            </div>
          </Card>
        </div>
      </div>
    </main>
  )
}

function Header() {
  return (
    <header className="flex items-center border-b border-border/60 px-8 py-4">
      <h1 className="text-sm font-medium uppercase tracking-[0.18em] text-foreground">
        New agent
      </h1>
    </header>
  )
}

function SectionLabel({
  icon: Icon,
  children,
}: {
  icon?: React.ComponentType<{ size?: number }>
  children: React.ReactNode
}) {
  return (
    <div className="flex items-center gap-2 text-sm font-medium text-foreground">
      {Icon && <Icon size={16} />}
      {children}
    </div>
  )
}

function Corners() {
  const positions = [
    "top-0 left-0",
    "top-0 right-0",
    "bottom-0 left-0",
    "bottom-0 right-0",
  ] as const
  return (
    <>
      {positions.map((pos) => {
        const isTop = pos.includes("top")
        const isLeft = pos.includes("left")
        return (
          <span
            key={pos}
            className={cn(
              "pointer-events-none absolute size-3 border-foreground/40",
              pos,
              isTop ? "border-t" : "border-b",
              isLeft ? "border-l" : "border-r"
            )}
          />
        )
      })}
    </>
  )
}

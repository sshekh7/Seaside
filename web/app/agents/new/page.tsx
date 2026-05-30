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
      fetch("/api/agent/generate-plan", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ agent_id: data.id }),
      })
    }
    router.push("/map")
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
              <Textarea
                value={personality}
                onChange={(e) => setPersonality(e.target.value)}
                placeholder="Describe how this agent should behave."
                rows={4}
              />
              <FieldDescription>
                Used as the system prompt for this agent.
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

import { Space_Grotesk } from "next/font/google"
import Link from "next/link"

const display = Space_Grotesk({
  subsets: ["latin"],
  weight: ["500", "700"],
})

export default function AboutPage() {
  return (
    <div className="min-h-svh bg-background text-foreground">
      <div className="mx-auto max-w-3xl px-6 py-16">
        {/* Header */}
        <h1
          className={`${display.className} text-4xl font-bold uppercase tracking-[-0.03em] sm:text-5xl`}
        >
          Seaside
        </h1>
        <p className="mt-3 text-lg text-muted-foreground">
          A city-scale AI simulation where hundreds of agents reason, adapt, and react to the real world.
        </p>

        <div className="mt-12 space-y-12">
          {/* What it is */}
          <section>
            <h2 className="text-[10px] font-medium uppercase tracking-[0.18em] text-muted-foreground">What we built</h2>
            <p className="mt-3 text-sm leading-relaxed">
              Seaside places 400+ AI agents in the city of Seattle. Each agent has a name, personality, job, home address, and daily routine. Every day, an LLM plans their entire schedule — where they go, what they do, and why — based on who they are and what's happening in the world around them.
            </p>
            <p className="mt-3 text-sm leading-relaxed">
              Agents commute on real roads using Mapbox routing. They eat at real restaurants, work in real offices, and make decisions the way people do — by reasoning about context, not following scripts.
            </p>
          </section>

          {/* How it works */}
          <section>
            <h2 className="text-[10px] font-medium uppercase tracking-[0.18em] text-muted-foreground">How it works</h2>
            <div className="mt-3 space-y-3 text-sm leading-relaxed">
              <div className="rounded border border-border/60 px-4 py-3">
                <p className="font-medium">1. Scrape the real world</p>
                <p className="mt-1 text-muted-foreground">Apify pulls live Seattle news — road closures, weather, events, transit disruptions — from Google News.</p>
              </div>
              <div className="rounded border border-border/60 px-4 py-3">
                <p className="font-medium">2. Store & summarize</p>
                <p className="mt-1 text-muted-foreground">Raw data is stored in Box. Box AI reads through the headlines and generates a concise world-context summary.</p>
              </div>
              <div className="rounded border border-border/60 px-4 py-3">
                <p className="font-medium">3. Agents reason & adapt</p>
                <p className="mt-1 text-muted-foreground">AWS Bedrock (Claude) plans each agent's day using their personality + the world context. Close a highway? Commuters reroute. Rain forecast? Outdoor plans shift indoors.</p>
              </div>
              <div className="rounded border border-border/60 px-4 py-3">
                <p className="font-medium">4. Visualize & analyze</p>
                <p className="mt-1 text-muted-foreground">Watch the simulation play out on a live Mapbox map. Scrub through days, track individuals, compare behavior patterns.</p>
              </div>
            </div>
          </section>

          {/* Use cases */}
          <section>
            <h2 className="text-[10px] font-medium uppercase tracking-[0.18em] text-muted-foreground">Who this is for</h2>
            <div className="mt-3 grid gap-3 sm:grid-cols-2">
              <div className="rounded border border-border/60 px-4 py-3">
                <p className="text-sm font-medium">🏙️ Urban Planning</p>
                <p className="mt-1 text-xs text-muted-foreground">Test infrastructure changes before breaking ground. What happens if you close this street? Add a bus route? Build a stadium?</p>
              </div>
              <div className="rounded border border-border/60 px-4 py-3">
                <p className="text-sm font-medium">🏪 Retail & Real Estate</p>
                <p className="mt-1 text-xs text-muted-foreground">Predict foot traffic for site selection. Simulate where realistic consumers cluster before signing a lease.</p>
              </div>
              <div className="rounded border border-border/60 px-4 py-3">
                <p className="text-sm font-medium">🎪 Event Management</p>
                <p className="mt-1 text-xs text-muted-foreground">Simulate crowd flow before doors open. Find bottlenecks, plan security, optimize vendor placement.</p>
              </div>
              <div className="rounded border border-border/60 px-4 py-3">
                <p className="text-sm font-medium">📊 Market Research</p>
                <p className="mt-1 text-xs text-muted-foreground">Test campaigns on synthetic consumers with real demographics before spending a dollar on media.</p>
              </div>
            </div>
          </section>

          {/* Vision */}
          <section>
            <h2 className="text-[10px] font-medium uppercase tracking-[0.18em] text-muted-foreground">Where we're going</h2>
            <p className="mt-3 text-sm leading-relaxed">
              Seaside is currently a proof of concept — 400 agents, one city, seven days. But there's no architectural limit. The system is city-agnostic. Swap the bounding box and seed data, and you have Portland, Austin, or Tokyo.
            </p>
            <ul className="mt-3 space-y-2 text-sm text-muted-foreground">
              <li className="flex gap-2"><span className="text-foreground">→</span> Scale to thousands of agents with distilled behavior models</li>
              <li className="flex gap-2"><span className="text-foreground">→</span> Multi-city support with custom demographics</li>
              <li className="flex gap-2"><span className="text-foreground">→</span> Inter-agent interaction (social networks, word-of-mouth)</li>
              <li className="flex gap-2"><span className="text-foreground">→</span> Backtesting against real historical data for validation</li>
              <li className="flex gap-2"><span className="text-foreground">→</span> Self-serve platform for scenario planning</li>
            </ul>
          </section>

          {/* Team */}
          <section>
            <h2 className="text-[10px] font-medium uppercase tracking-[0.18em] text-muted-foreground">Team</h2>
            <p className="mt-3 text-sm leading-relaxed">
              Built by Shaan Shekhar, Priyanshu Mahey, and Rupak Ghosh at the AWS × Box × Apify hackathon in Seattle. Honorable mention winner.
            </p>
          </section>

          {/* CTA */}
          <section className="rounded border border-border/60 bg-card px-6 py-6 text-center">
            <p className="text-sm font-medium">Interested in what Seaside can do for your use case?</p>
            <p className="mt-2 text-xs text-muted-foreground">We're exploring partnerships and pilot customers.</p>
            <a
              href="mailto:shaansshekhar@gmail.com"
              className="mt-4 inline-block rounded bg-foreground px-4 py-2 text-xs font-medium text-background transition hover:opacity-90"
            >
              Get in touch
            </a>
          </section>
        </div>

        <div className="mt-12 text-center">
          <Link href="/map" className="text-xs text-muted-foreground underline hover:text-foreground transition">
            → See the simulation
          </Link>
        </div>
      </div>
    </div>
  )
}

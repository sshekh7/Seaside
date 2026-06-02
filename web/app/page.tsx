import { Space_Grotesk } from "next/font/google"

import { TerrainHero } from "@/components/terrain-hero"

const display = Space_Grotesk({
  subsets: ["latin"],
  weight: ["500", "700"],
})

export default function Page() {
  return (
    <div className="relative min-h-svh w-full overflow-hidden bg-[#05060a]">
      <TerrainHero />
      <span
        className={`${display.className} pointer-events-none absolute right-8 top-6 z-10 text-5xl font-bold uppercase tracking-[-0.03em] text-foreground drop-shadow-[0_2px_12px_rgba(0,0,0,0.6)] sm:text-6xl lg:text-7xl`}
      >
        Seaside
      </span>
      <div className="pointer-events-none absolute left-8 top-6 z-10 max-w-md sm:left-12 sm:top-10">
        <p className={`${display.className} text-xl font-medium leading-tight text-foreground/90 drop-shadow-[0_2px_8px_rgba(0,0,0,0.8)] sm:text-2xl`}>
          A city that thinks.
        </p>
        <p className="mt-3 text-sm leading-relaxed text-foreground/60 drop-shadow-[0_1px_6px_rgba(0,0,0,0.8)]">
          400 AI agents living in Seattle — reasoning, commuting, adapting to real-world events. Drop a headline, watch the city react.
        </p>
      </div>
    </div>
  )
}

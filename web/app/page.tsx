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
    </div>
  )
}

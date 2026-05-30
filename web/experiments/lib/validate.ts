// Validate a skeleton: geocode each location, compute travel between
// consecutive beats, fit travel into gaps by shifting downstream beats.
// Returns finalized Beat[] + stats.

import { directions, geocode, haversineKm, pickMode } from "./mapbox"
import type { Beat, SkeletonBeat } from "./types"

export type ValidationStats = {
  overflow_fixed_by_shift: number
  overflow_remaining: number
  geocode_failures: string[]
  compressed_to_fit_day: boolean
  compressed_minutes_saved: number
  sleep_beat_synthesized: boolean
  returned_home_before_sleep: boolean
}

const DAY_END_HOUR = 23
const DAY_END_MIN = 30
// Sleep is allowed to cross into the next day; we cap it here.
const SLEEP_END_HOUR_NEXT_DAY = 6
const MIN_SLEEP_HOURS = 6

function endOfDayBoundary(firstStart: Date): Date {
  const d = new Date(firstStart)
  d.setHours(DAY_END_HOUR, DAY_END_MIN, 0, 0)
  // If first beat already crosses end, push out 24h
  if (d <= firstStart) d.setDate(d.getDate() + 1)
  return d
}

function sleepEndBoundary(firstStart: Date): Date {
  // Latest the sleep beat can end: 06:00 of the day AFTER the first beat.
  const d = new Date(firstStart)
  d.setDate(d.getDate() + 1)
  d.setHours(SLEEP_END_HOUR_NEXT_DAY, 0, 0, 0)
  return d
}

export async function validateAndAttachTravel(
  skeleton: SkeletonBeat[],
  homeLocation: [number, number],
): Promise<{ beats: Beat[]; stats: ValidationStats }> {
  // 1. Geocode every beat location.
  //    First/last beat or anything containing "home": resolve to homeLocation.
  const locations: ([number, number] | null)[] = []
  const failures: string[] = []
  for (let i = 0; i < skeleton.length; i++) {
    const b = skeleton[i]
    const name = b.location_name.trim()
    const isLast = i === skeleton.length - 1
    if (
      i === 0 ||
      isLast ||
      b.activity_type === "home" ||
      b.activity_type === "sleep" ||
      /\bhome\b/i.test(name)
    ) {
      locations.push(homeLocation)
      continue
    }
    const loc = await geocode(name)
    if (!loc) {
      failures.push(name)
      // Fallback: stay at previous location
      locations.push(locations[i - 1] ?? homeLocation)
    } else {
      locations.push(loc)
    }
  }

  // 2. Walk beats, compute travel, shift downstream when overflowed.
  const beats: Beat[] = []
  const times: { start: Date; end: Date }[] = skeleton.map((b) => ({
    start: new Date(b.start_time),
    end: new Date(b.end_time),
  }))

  // Pre-clean: any beat where end <= start (skeleton repair missed it) gets
  // a default 20-minute duration. Stops negative bars on the timeline.
  for (let i = 0; i < times.length; i++) {
    if (times[i].end.getTime() <= times[i].start.getTime()) {
      times[i].end = new Date(times[i].start.getTime() + 20 * 60 * 1000)
    }
  }

  let overflowFixed = 0

  const travels: (Beat["travel_from_prev"])[] = []
  travels[0] = null

  for (let i = 0; i < skeleton.length; i++) {
    if (i === 0) continue
    const prevLoc = locations[i - 1]!
    const loc = locations[i]!
    const same = prevLoc[0] === loc[0] && prevLoc[1] === loc[1]
    let travel: Beat["travel_from_prev"] = null
    if (!same) {
      // Mode picker: walking if <1.5km, otherwise driving. If the LLM marked
      // this beat "commute" or labeled it long-distance and the straight-line
      // is < 200m, treat as same-place (skip travel) — a "drive" of 200m is
      // visibly broken.
      const straight = haversineKm(prevLoc, loc)
      if (straight < 0.05) {
        // Effectively the same coordinate — skip travel.
        travels[i] = null
        continue
      }
      const mode = pickMode(prevLoc, loc)
      const route = await directions(prevLoc, loc, mode)
      if (route) {
        travel = {
          mode,
          polyline: route.polyline,
          duration_minutes: route.duration_minutes,
        }
        const gap = (times[i].start.getTime() - times[i - 1].end.getTime()) / 60000
        const overflow = route.duration_minutes - gap
        if (overflow > 0) {
          const shiftMs = overflow * 60000
          for (let j = i; j < times.length; j++) {
            times[j].start = new Date(times[j].start.getTime() + shiftMs)
            times[j].end = new Date(times[j].end.getTime() + shiftMs)
          }
          overflowFixed++
        }
      } else {
        // Route rejected (likely bad geocode that slipped through, or Mapbox
        // failure). Force this beat's location back to the previous beat's
        // location so the agent doesn't teleport.
        locations[i] = prevLoc
        failures.push(`${skeleton[i].location_name} (no route)`)
      }
    }
    travels[i] = travel
  }

  // 3. Compression pass: if last beat ends past 23:30, shrink the non-travel
  //    durations of stationary beats proportionally until it fits. We never
  //    touch travel durations (those are real Mapbox numbers). If we can't
  //    fit even with all stays at the 5-min floor, we DROP tail beats one
  //    by one until the day closes by 23:30.
  let compressed = false
  let savedMinutes = 0
  const dayBoundary = endOfDayBoundary(times[0].start)
  let lastEnd = times[times.length - 1].end
  if (lastEnd > dayBoundary) {
    const overrunMs = lastEnd.getTime() - dayBoundary.getTime()
    savedMinutes = Math.ceil(overrunMs / 60000)
    let totalStay = 0
    const stayMs: number[] = []
    for (let i = 0; i < times.length; i++) {
      const s = times[i].end.getTime() - times[i].start.getTime()
      stayMs.push(s)
      totalStay += s
    }
    const floor = 5 * 60 * 1000
    if (totalStay > overrunMs) {
      const scale = (totalStay - overrunMs) / totalStay
      const newStayMs: number[] = stayMs.map((s) => Math.max(floor, Math.round(s * scale)))
      const newTimes: { start: Date; end: Date }[] = []
      let cursor = times[0].start.getTime()
      for (let i = 0; i < times.length; i++) {
        if (i > 0) {
          const originalGap = times[i].start.getTime() - times[i - 1].end.getTime()
          cursor += originalGap
        }
        const start = new Date(cursor)
        const end = new Date(cursor + newStayMs[i])
        newTimes.push({ start, end })
        cursor = end.getTime()
      }
      if (newTimes[newTimes.length - 1].end <= dayBoundary) {
        for (let i = 0; i < times.length; i++) {
          times[i].start = newTimes[i].start
          times[i].end = newTimes[i].end
        }
        compressed = true
      }
    }
    // If compression still didn't fit, drop tail beats. We always keep at
    // least one beat (the wake-up beat, which is at home).
    while (!compressed && times[times.length - 1].end > dayBoundary && times.length > 1) {
      times.pop()
      skeleton.pop()
      locations.pop()
      travels.pop()
    }
    lastEnd = times[times.length - 1].end
    if (lastEnd <= dayBoundary && !compressed) compressed = true
  }

  // 4. End-of-day fixup: guarantee the agent (a) is at home before sleeping
  //    and (b) has a sleep beat long enough to look like a real night.
  let sleepBeatSynthesized = false
  let returnedHomeBeforeSleep = true
  const lastIdx = skeleton.length - 1
  const lastLoc = locations[lastIdx]!
  const homeMatch = lastLoc[0] === homeLocation[0] && lastLoc[1] === homeLocation[1]
  const lastBeatEnd = times[lastIdx].end
  const lastIsSleep = skeleton[lastIdx].activity_type === "sleep"
  const lastDurationH =
    (lastBeatEnd.getTime() - times[lastIdx].start.getTime()) / 3_600_000

  // If the agent isn't at home for the final beat, force-route them home
  // and replace the final beat with a sleep beat. We add a commute beat
  // between if there was meaningful distance.
  if (!homeMatch) {
    returnedHomeBeforeSleep = false
    const straight = haversineKm(lastLoc, homeLocation)
    if (straight > 0.05) {
      const mode = pickMode(lastLoc, homeLocation)
      const route = await directions(lastLoc, homeLocation, mode)
      if (route) {
        // Insert a commute beat. It starts when the prior beat ended.
        const commuteStart = lastBeatEnd
        const commuteEnd = new Date(
          commuteStart.getTime() + route.duration_minutes * 60_000,
        )
        const commuteBeat: SkeletonBeat = {
          index: skeleton.length,
          start_time: commuteStart.toISOString(),
          end_time: commuteEnd.toISOString(),
          activity: "Head home for the night",
          activity_type: "commute",
          location_name: skeleton[0].location_name, // "Home (<neighborhood>)"
          reasoning: "(auto) ensure agent ends day at home",
        }
        skeleton.push(commuteBeat)
        locations.push(homeLocation)
        times.push({ start: commuteStart, end: commuteEnd })
        travels.push({
          mode,
          polyline: route.polyline,
          duration_minutes: route.duration_minutes,
        })
      }
    }
  }

  // Now ensure the last beat is "sleep" at home, lasting >= MIN_SLEEP_HOURS.
  const sleepBoundary = sleepEndBoundary(times[0].start)
  const finalIdx = skeleton.length - 1
  const finalEnd = times[finalIdx].end
  // Sleep should end at 06:00 next day; only push past that if MIN_SLEEP_HOURS
  // forces it (e.g. the LLM somehow emitted a beat starting after midnight).
  const sleepEnd = new Date(
    Math.max(
      sleepBoundary.getTime(),
      finalEnd.getTime() + MIN_SLEEP_HOURS * 3_600_000,
    ),
  )

  if (!lastIsSleep) {
    // Append a synthetic sleep beat from the last beat's end through the
    // sleep boundary.
    const sleepStart = finalEnd
    const sleepBeat: SkeletonBeat = {
      index: skeleton.length,
      start_time: sleepStart.toISOString(),
      end_time: sleepEnd.toISOString(),
      activity: "Sleep",
      activity_type: "sleep",
      location_name: skeleton[0].location_name, // "Home (<neighborhood>)"
      reasoning: "(auto) overnight rest at home",
    }
    skeleton.push(sleepBeat)
    locations.push(homeLocation)
    times.push({ start: sleepStart, end: sleepEnd })
    travels.push(null)
    sleepBeatSynthesized = true
  } else if (lastDurationH < MIN_SLEEP_HOURS) {
    // Extend the existing sleep beat to at least MIN_SLEEP_HOURS.
    times[finalIdx].end = sleepEnd
  }

  // 5. Final pass: clamp any beat whose end still snuck past the sleep
  //    boundary (shouldn't happen after the above, but defense in depth).
  for (let i = 0; i < times.length - 1; i++) {
    if (times[i].end > times[i + 1].start) {
      times[i].end = new Date(times[i + 1].start.getTime())
    }
    if (times[i].end.getTime() <= times[i].start.getTime()) {
      times[i].end = new Date(times[i].start.getTime() + 5 * 60 * 1000)
    }
  }

  // 6. Emit final beats
  for (let i = 0; i < skeleton.length; i++) {
    const b = skeleton[i]
    beats.push({
      index: i,
      start_time: times[i].start.toISOString(),
      end_time: times[i].end.toISOString(),
      activity: b.activity,
      activity_type: b.activity_type,
      location_name: b.location_name,
      location: locations[i]!,
      travel_from_prev: travels[i] ?? null,
      reasoning: b.reasoning,
    })
  }

  const overflowRemaining =
    times[times.length - 1].end > sleepEndBoundary(times[0].start) ? 1 : 0

  return {
    beats,
    stats: {
      overflow_fixed_by_shift: overflowFixed,
      overflow_remaining: overflowRemaining,
      geocode_failures: failures,
      compressed_to_fit_day: compressed,
      compressed_minutes_saved: compressed ? savedMinutes : 0,
      sleep_beat_synthesized: sleepBeatSynthesized,
      returned_home_before_sleep: returnedHomeBeforeSleep,
    },
  }
}

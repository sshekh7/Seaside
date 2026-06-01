# Seaside — Architecture

```
┌─────────────────────────────────────────────────────────────────────────┐
│                          REAL WORLD                                       │
│                                                                           │
│   📰 Seattle Times    🌐 Reddit r/Seattle    📅 Event Calendars          │
│   🌤️ Weather APIs     🚗 Traffic Data        📢 Breaking News            │
└───────────────────────────────────┬───────────────────────────────────────┘
                                    │
                                    ▼
┌───────────────────────────────────────────────────────────────────────────┐
│                         🕷️  APIFY (Web Scraping)                          │
│                                                                           │
│   • Crawls Seattle news sources on schedule                               │
│   • Extracts headlines, events, closures, weather                         │
│   • Structures raw data into event payloads                               │
└───────────────────────────────────┬───────────────────────────────────────┘
                                    │
                                    ▼
┌───────────────────────────────────────────────────────────────────────────┐
│                     📦  BOX (Central Knowledge Store)                      │
│                                                                           │
│   ┌──────────────┐  ┌──────────────┐  ┌──────────────────────┐           │
│   │ World Events │  │ Agent Diaries│  │ Simulation Artifacts │           │
│   │   (JSON)     │  │   (PDF)      │  │   (Reports, Logs)    │           │
│   └──────────────┘  └──────────────┘  └──────────────────────┘           │
│                                                                           │
│   • Single source of truth for all simulation context                     │
│   • Box AI summarizes & indexes documents                                 │
│   • Agents query Box for relevant world knowledge                         │
└───────────────────────────────────┬───────────────────────────────────────┘
                                    │
                                    ▼
┌───────────────────────────────────────────────────────────────────────────┐
│                  🧠  AWS BEDROCK (Claude Haiku 4.5)                        │
│                                                                           │
│   ┌─────────────────────────────────────────────────────────────┐         │
│   │                    Agent Decision Engine                      │         │
│   │                                                              │         │
│   │  INPUT:                          OUTPUT:                     │         │
│   │  • Agent personality             • Next activity             │         │
│   │  • Current location              • Destination               │         │
│   │  • Time of day                   • Duration                  │         │
│   │  • Recent memories               • Reasoning                 │         │
│   │  • World events (from Box)       • Diary entry               │         │
│   └─────────────────────────────────────────────────────────────┘         │
│                                                                           │
│   • 200+ agents making independent decisions                              │
│   • Personality-driven behavior (not scripted)                            │
│   • Reacts to real-world events naturally                                 │
└───────────────────────────────────┬───────────────────────────────────────┘
                                    │
                                    ▼
┌───────────────────────────────────────────────────────────────────────────┐
│                    🗺️  SIMULATION (Next.js + Mapbox)                       │
│                                                                           │
│   ┌────────────┐  ┌────────────┐  ┌────────────┐  ┌────────────┐         │
│   │  3D Map    │  │  Timeline  │  │  Activity  │  │  Agent     │         │
│   │  View      │  │  Playback  │  │  Stream    │  │  Profiles  │         │
│   └────────────┘  └────────────┘  └────────────┘  └────────────┘         │
│                                                                           │
│   • Agents walk real pedestrian routes (Mapbox Directions API)            │
│   • 7-day pre-computed schedules with live event injection                │
│   • Visual proof: inject "Pike Place closed" → agents reroute            │
└───────────────────────────────────────────────────────────────────────────┘
```

## Data Flow

```
Apify scrapes news  →  Stored in Box  →  Bedrock reads context  →  Agent decides  →  Map animates
     (5 min)              (JSON)           (per decision)           (activity)        (real-time)
```

## Key Insight

> "Drop a news article into the system. Watch 200 AI agents change their plans."

The agents don't follow scripts — they **reason** about their world using the same information humans would read in the morning news. When the world changes, their behavior changes.

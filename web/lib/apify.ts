import { ApifyClient } from "apify-client"

const ACTOR_ID = "automation-lab/google-news-scraper"

function getClient() {
  const token = process.env.APIFY_API_TOKEN
  if (!token) throw new Error("Missing APIFY_API_TOKEN")
  return new ApifyClient({ token })
}

export type ScrapeResult = {
  title: string
  source?: string
  publishedAt?: string
  snippet?: string
  url?: string
}

/** Start a Google News scrape for Seattle and return the run ID */
export async function startScrape(query = "Seattle news today") {
  const client = getClient()
  const run = await client.actor(ACTOR_ID).call({
    queries: [query],
    language: "en",
    country: "US",
    maxArticles: 20,
  })
  return { runId: run.id, status: run.status }
}

/** Get results from a completed run */
export async function getScrapeResults(runId: string): Promise<{
  status: string
  items: ScrapeResult[]
}> {
  const client = getClient()
  const run = await client.run(runId).get()
  if (!run) return { status: "NOT_FOUND", items: [] }
  if (run.status !== "SUCCEEDED") return { status: run.status, items: [] }

  const { items } = await client.dataset(run.defaultDatasetId).listItems({ limit: 50 })
  const results: ScrapeResult[] = items.map((item: Record<string, unknown>) => ({
    title: (item.title as string) || (item.headline as string) || "",
    source: (item.source as string) || (item.publisher as string) || undefined,
    publishedAt: (item.publishedAt as string) || (item.date as string) || undefined,
    snippet: (item.snippet as string) || (item.description as string) || undefined,
    url: (item.url as string) || (item.link as string) || undefined,
  }))
  return { status: "SUCCEEDED", items: results }
}

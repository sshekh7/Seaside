import BoxSDK from "box-node-sdk"

// Box uses a Developer Token for quick setup, or a Service Account (JWT) for production.
// Set BOX_DEVELOPER_TOKEN in .env.local for development.
// For production, set BOX_CLIENT_ID, BOX_CLIENT_SECRET, BOX_ENTERPRISE_ID,
// BOX_PRIVATE_KEY, BOX_PRIVATE_KEY_ID, BOX_PASSPHRASE and switch to getAppClient().

function getBoxClient() {
  const devToken = process.env.BOX_DEVELOPER_TOKEN

  if (!devToken) {
    throw new Error("No Box token set. Please enter a Developer Token in the Pipeline page.")
  }

  return BoxSDK.getBasicClient(devToken)
}

/**
 * Ensures a folder path like ["Seaside Daily Reports", "2026-06-01"] exists
 * under parentId (default: root "0"), creating missing segments.
 * Returns the leaf folder ID.
 */
async function ensureBoxFolderPath(
  client: ReturnType<typeof getBoxClient>,
  segments: string[],
  rootId = "0"
): Promise<string> {
  let currentId = rootId

  for (const segment of segments) {
    const items = await client.folders.getItems(currentId, { fields: "id,name,type" })
    const existing = items.entries.find(
      (e: { type: string; name: string }) => e.type === "folder" && e.name === segment
    )

    if (existing) {
      currentId = existing.id
    } else {
      const created = await client.folders.create(currentId, segment)
      currentId = created.id
    }
  }

  return currentId
}

export { getBoxClient, ensureBoxFolderPath }

/** Upload a JSON payload as a file to Box */
export async function uploadJsonToBox(
  filename: string,
  data: unknown,
  folderSegments: string[] = ["Seaside", "scrapes"],
) {
  const client = getBoxClient()
  const folderId = await ensureBoxFolderPath(client, folderSegments)
  const buffer = Buffer.from(JSON.stringify(data, null, 2))

  // Check if file already exists
  const items = await client.folders.getItems(folderId, { fields: "id,name,type" })
  const existing = items.entries.find(
    (e: { type: string; name: string }) => e.type === "file" && e.name === filename
  )

  if (existing) {
    // Upload new version
    const file = await client.files.uploadNewFileVersion(existing.id, buffer)
    return { fileId: file.entries[0].id, name: file.entries[0].name }
  }

  const file = await client.files.uploadFile(folderId, filename, buffer)
  return { fileId: file.entries[0].id, name: file.entries[0].name }
}

/** Ask Box AI to summarize a file */
export async function askBoxAI(fileId: string, prompt: string): Promise<string> {
  const token = process.env.BOX_DEVELOPER_TOKEN
  if (!token) throw new Error("Missing BOX_DEVELOPER_TOKEN for AI call")

  const res = await fetch("https://api.box.com/2.0/ai/ask", {
    method: "POST",
    headers: {
      "Authorization": `Bearer ${token}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      mode: "single_item_qa",
      prompt,
      items: [{ type: "file", id: fileId }],
    }),
  })

  if (!res.ok) {
    const err = await res.text()
    throw new Error(`Box AI error [${res.status}]: ${err}`)
  }

  const data = await res.json()
  return data.answer
}

/** List files in a Box folder */
export async function listBoxFolder(folderSegments: string[] = ["Seaside"]) {
  const client = getBoxClient()
  let folderId: string
  try {
    folderId = await ensureBoxFolderPath(client, folderSegments)
  } catch {
    return []
  }
  const items = await client.folders.getItems(folderId, { fields: "id,name,type,size,modified_at" })
  return items.entries.map((e: Record<string, unknown>) => ({
    id: e.id,
    name: e.name,
    type: e.type,
    size: e.size,
    modified_at: e.modified_at,
  }))
}

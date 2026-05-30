import BoxSDK from "box-node-sdk"

// Box uses a Developer Token for quick setup, or a Service Account (JWT) for production.
// Set BOX_DEVELOPER_TOKEN in .env.local for development.
// For production, set BOX_CLIENT_ID, BOX_CLIENT_SECRET, BOX_ENTERPRISE_ID,
// BOX_PRIVATE_KEY, BOX_PRIVATE_KEY_ID, BOX_PASSPHRASE and switch to getAppClient().

function getBoxClient() {
  const devToken = process.env.BOX_DEVELOPER_TOKEN

  if (devToken) {
    // Development: use a short-lived developer token from the Box dev console
    const sdk = BoxSDK.getBasicClient(devToken)
    return sdk
  }

  // Production: JWT service account
  const required = [
    "BOX_CLIENT_ID",
    "BOX_CLIENT_SECRET",
    "BOX_ENTERPRISE_ID",
    "BOX_PRIVATE_KEY",
    "BOX_PRIVATE_KEY_ID",
    "BOX_PASSPHRASE",
  ]
  for (const key of required) {
    if (!process.env[key]) throw new Error(`Missing Box env var: ${key}`)
  }

  const sdk = new BoxSDK({
    clientID: process.env.BOX_CLIENT_ID!,
    clientSecret: process.env.BOX_CLIENT_SECRET!,
    appAuth: {
      algorithm: "RS256",
      expirationTime: 30,
      verifyTimestamp: true,
      keyID: process.env.BOX_PRIVATE_KEY_ID!,
      privateKey: process.env.BOX_PRIVATE_KEY!.replace(/\\n/g, "\n"),
      passphrase: process.env.BOX_PASSPHRASE!,
    },
  })

  return sdk.getAppAuthClient(process.env.BOX_ENTERPRISE_ID!)
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

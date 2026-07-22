# Macroscope Chat

A small, dependency-free local chat client for Macroscope Agent Webhooks. It uses Node.js built-ins and plain browser HTML, CSS, and JavaScript.

## Requirements

- Node.js 20 or newer
- A Macroscope webhook URL and webhook API key
- Optional: [`cloudflared`](https://developers.cloudflare.com/cloudflare-one/networks/connectors/cloudflare-tunnel/downloads/) to generate a temporary external webhook URL

No package installation, Docker, database, frontend build, or external npm package is required.

## Start the application

From this directory, run either:

```bash
npm start
```

or:

```bash
node server.js
```

Then open [http://127.0.0.1:8787](http://127.0.0.1:8787) in a browser. The server binds only to `127.0.0.1`.

## Configure credentials

Open **Settings**, enter the HTTPS Macroscope webhook trigger URL and webhook API key, then choose **Save for Session**. The configured indicator will change to **Configured**. Use **Clear Credentials** to remove them explicitly.

Credentials are held only in the Node process's memory. They are not written to files, browser storage, cookies, URLs, or API responses. The token field is cleared after saving, and all credentials disappear when the process stops.

You may initialize the in-memory settings when starting the server:

```bash
MACROSCOPE_WEBHOOK_URL="https://example.com/webhook" \
MACROSCOPE_API_TOKEN="your-token" \
npm start
```

Settings saved in the browser UI replace these values for the current process.

## Webhook and polling flow

Each chat message is independent. The local server sends the message to the configured webhook as `{"query":"..."}` with the API key in the `X-Webhook-Secret` header. It expects the trigger response to contain `pollUrl` and `jobToken`, then polls the returned URL using `Authorization: Bearer <jobToken>` until the request completes, fails, expires, is canceled, or reaches the 55-minute timeout. `Retry-After` is honored within the one-to-fifteen-second polling limits. The polling URL does not need to be configured separately.

If your webhook expects a different body field or extra context, edit the `buildTriggerPayload()` function in `server.js`. That function is intentionally the single payload customization point.

## Receive responses through an external webhook

The app can create a temporary public webhook for an agent or service to post responses back to the local chat. Install the Cloudflare Tunnel client on macOS with:

```bash
brew install cloudflared
```

Open **Settings**, find **External webhook**, and choose **Generate External URL**. The app starts a [Cloudflare Quick Tunnel](https://developers.cloudflare.com/cloudflare-one/networks/connectors/cloudflare-tunnel/do-more-with-tunnels/trycloudflare/) to a dedicated local webhook listener. Copy the generated URL into the Macroscope Macro's webhook destination field. No custom header is required.

Send a JSON object using one of the `response`, `message`, `content`, or `text` fields:

```bash
curl -X POST "https://example.trycloudflare.com/hooks/example" \
  -H "Content-Type: application/json" \
  -d '{"response":"Completed the requested task."}'
```

Incoming responses appear in the open chat page within a few seconds. The generated URL contains a long random credential and must be treated like a password. It is kept only in memory. **Stop & Revoke** terminates the tunnel and invalidates the URL. Quick Tunnel URLs are temporary, work only while this app is running, and are intended for development rather than production.

Only the dedicated webhook listener is tunneled; the settings and chat-control APIs remain on the local-only application server. The listener requires a 256-bit random URL credential, limits request sizes, and treats received content as untrusted display data.

## Known limitations

- One request can run at a time in each browser page.
- Conversation history exists only in page memory and is not sent with later requests.
- Restarting Node clears credentials and refreshing clears the displayed chat.
- External webhook messages are held only in memory, and the latest 100 are retained until the app restarts.
- Generating an external URL requires the separately installed `cloudflared` command and outbound internet access.
- The response formatter supports common paragraphs, lists, inline code, and fenced code blocks, but is not a complete Markdown implementation.
- This is a lightweight local client, not a hardened production authentication service or multi-user application.

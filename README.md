# Macroscope Chat

A small, dependency-free local chat client for Macroscope Agent Webhooks. It uses Node.js built-ins and plain browser HTML, CSS, and JavaScript.

## Requirements

- Node.js 20 or newer
- A Macroscope webhook URL and webhook API key

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

## Markdown responses

Assistant responses are rendered as safe Markdown. Supported formatting includes:

- Headings, paragraphs, and horizontal rules
- Bold, italic, strikethrough, and inline code
- Ordered, unordered, and task lists
- Blockquotes and links
- Fenced code blocks with language labels and a copy button

Raw HTML is displayed as text rather than injected into the page. Links are limited to HTTP, HTTPS, and email URLs and open in a new tab with opener access disabled.

## Known limitations

- One request can run at a time in each browser page.
- Conversation history exists only in page memory and is not sent with later requests.
- Restarting Node clears credentials and refreshing clears the displayed chat.
- The response formatter supports common Markdown syntax, but is not a complete CommonMark implementation (for example, tables and nested lists are not supported).
- This is a lightweight local client, not a hardened production authentication service or multi-user application.

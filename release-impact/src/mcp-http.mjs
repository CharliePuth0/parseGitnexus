/**
 * Minimal MCP Streamable-HTTP client + server supervisor — zero npm dependencies.
 *
 * GitNexus exposes its full tool surface (`detect_changes`, `impact`, `context`, ...)
 * over MCP. The built CLI only prints human-formatted text for `detect-changes`
 * (see src/gitnexus-client.mjs), so MCP is the ONLY surface that returns the complete
 * changed-symbol set — the CLI path is a degraded fallback, not an equal alternative.
 *
 * Transport facts verified against gitnexus 1.6.12 (`src/mcp/http-transport.ts`):
 *   - `gitnexus mcp --http --port <p>` listens on 127.0.0.1:<p> and serves
 *     Streamable HTTP at POST /mcp.
 *   - `initialize` returns an `mcp-session-id` response header; every later request
 *     must echo it back or the server answers 400.
 *   - Responses come back as `text/event-stream` frames (`event: message` +
 *     `data: <json>`), so the body is parsed as SSE first and as plain JSON second.
 */
import { spawn } from 'node:child_process';
import net from 'node:net';

/** Protocol revision the installed server negotiates (its own `protocolVersion`). */
export const MCP_PROTOCOL_VERSION = '2024-11-05';

/** Ask the OS for a free TCP port, then release it for the child to bind. */
export function findFreePort() {
  return new Promise((resolve, reject) => {
    const probe = net.createServer();
    probe.unref();
    probe.on('error', reject);
    probe.listen(0, '127.0.0.1', () => {
      const { port } = probe.address();
      probe.close(() => resolve(port));
    });
  });
}

/** Pull the JSON-RPC messages out of a body that may be SSE-framed or plain JSON. */
export function parseRpcBody(body) {
  const messages = [];
  const trimmed = (body ?? '').trim();
  if (trimmed.length === 0) return messages;

  if (trimmed.startsWith('event:') || trimmed.includes('\ndata:') || trimmed.startsWith('data:')) {
    for (const line of trimmed.split('\n')) {
      if (!line.startsWith('data:')) continue;
      const payload = line.slice('data:'.length).trim();
      if (payload.length === 0) continue;
      try {
        messages.push(JSON.parse(payload));
      } catch {
        // A keep-alive or a partial frame is not an answer; skip it.
      }
    }
    if (messages.length > 0) return messages;
  }

  try {
    const parsed = JSON.parse(trimmed);
    return Array.isArray(parsed) ? parsed : [parsed];
  } catch {
    return messages;
  }
}

/** Human-readable reason for a non-2xx HTTP response, without leaking a whole body. */
function httpErrorDetail(status, body) {
  const snippet = (body ?? '').replace(/\s+/g, ' ').trim().slice(0, 200);
  return snippet.length > 0 ? `HTTP ${status}: ${snippet}` : `HTTP ${status}`;
}

export class McpHttpClient {
  constructor({ url, sessionId = null, timeoutMs = 60_000 }) {
    this.url = url;
    this.sessionId = sessionId;
    this.timeoutMs = timeoutMs;
    this.nextId = 1;
  }

  /** POST one JSON-RPC message and return the matching response object. */
  async #rpc(message, timeoutMs) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs ?? this.timeoutMs);
    let response;
    try {
      response = await fetch(this.url, {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          // The transport answers with SSE unless plain JSON is explicitly accepted.
          accept: 'application/json, text/event-stream',
          ...(this.sessionId ? { 'mcp-session-id': this.sessionId } : {}),
        },
        body: JSON.stringify(message),
        signal: controller.signal,
      });
    } catch (error) {
      clearTimeout(timer);
      if (error?.name === 'AbortError') {
        throw new Error(`MCP request timed out after ${timeoutMs ?? this.timeoutMs}ms (${message.method})`);
      }
      throw new Error(`MCP transport error for ${message.method}: ${error?.message ?? error}`);
    }
    clearTimeout(timer);

    const sessionHeader = response.headers.get('mcp-session-id');
    if (sessionHeader) this.sessionId = sessionHeader;

    const body = await response.text();
    if (!response.ok) throw new Error(httpErrorDetail(response.status, body));

    const messages = parseRpcBody(body);
    const match = messages.find((entry) => entry?.id === message.id) ?? messages[0];
    if (!match) throw new Error(`MCP returned no JSON-RPC message for ${message.method}`);
    if (match.error) {
      throw new Error(`MCP error for ${message.method}: ${match.error.message ?? JSON.stringify(match.error)}`);
    }
    return match;
  }

  /** Handshake. Returns `this` so callers can chain `connect`. */
  async initialize() {
    const result = await this.#rpc(
      {
        jsonrpc: '2.0',
        id: this.nextId++,
        method: 'initialize',
        params: {
          protocolVersion: MCP_PROTOCOL_VERSION,
          capabilities: {},
          clientInfo: { name: 'release-impact', version: '1' },
        },
      },
      20_000,
    );
    // Protocol courtesy: the server does not require it, but a compliant client announces.
    await this.#notify('notifications/initialized', {});
    this.serverInfo = result?.result?.serverInfo ?? null;
    return this;
  }

  async #notify(method, params) {
    try {
      await fetch(this.url, {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          accept: 'application/json, text/event-stream',
          ...(this.sessionId ? { 'mcp-session-id': this.sessionId } : {}),
        },
        body: JSON.stringify({ jsonrpc: '2.0', method, params }),
      });
    } catch {
      // Notifications are fire-and-forget; a dropped one never fails the run.
    }
  }

  /**
   * Call a tool and return its parsed JSON payload.
   *
   * MCP wraps tool output in `content: [{type:'text', text}]`, and GitNexus appends a
   * human `---\n**Next:** ...` trailer to that text, so the payload is recovered with
   * the balanced-brace scanner rather than a bare JSON.parse.
   */
  async callTool(name, args, { timeoutMs } = {}) {
    const response = await this.#rpc(
      {
        jsonrpc: '2.0',
        id: this.nextId++,
        method: 'tools/call',
        params: { name, arguments: args },
      },
      timeoutMs,
    );

    const result = response?.result;
    if (result?.isError) {
      const detail = result?.content?.[0]?.text ?? 'unknown MCP tool error';
      throw new Error(`${name} failed: ${String(detail).slice(0, 300)}`);
    }
    const text = (result?.content ?? [])
      .filter((part) => part?.type === 'text')
      .map((part) => part.text)
      .join('\n');

    const { extractFirstJsonObject } = await import('./util.mjs');
    const payload = extractFirstJsonObject(text);
    if (!payload) {
      throw new Error(`${name} returned no JSON payload (${text.slice(0, 200)})`);
    }
    return payload;
  }
}

/** Connect to an MCP HTTP endpoint that is already running (`--mcp-url`). */
export async function connectToMcp(url, { timeoutMs = 30_000 } = {}) {
  const client = new McpHttpClient({ url, timeoutMs });
  await client.initialize();
  return client;
}

/**
 * Spawn `gitnexus mcp --http` on a free port, wait for it to answer, and hand back
 * a client plus a `stop()` that always reaps the child.
 *
 * The child is never detached: if this process dies, the child dies with it, so a
 * crashed run cannot leave an orphaned server holding the port.
 */
export async function startMcpServer({ cliPath, cwd, log = () => {}, bootTimeoutMs = 60_000 }) {
  const port = await findFreePort();
  const url = `http://127.0.0.1:${port}/mcp`;

  const child = spawn(process.execPath, [cliPath, 'mcp', '--http', '--port', String(port)], {
    cwd,
    stdio: ['ignore', 'pipe', 'pipe'],
  });

  let stderrTail = '';
  child.stderr?.on('data', (chunk) => {
    stderrTail = (stderrTail + String(chunk)).slice(-2000);
  });
  child.stdout?.on('data', () => {
    // The banner the CLI prints before the server starts is not needed.
  });

  let exited = null;
  child.on('exit', (code, signal) => {
    exited = { code, signal };
  });

  const stop = async () => {
    if (exited) return;
    child.kill('SIGTERM');
    const deadline = Date.now() + 3000;
    while (!exited && Date.now() < deadline) {
      await new Promise((resolve) => setTimeout(resolve, 50));
    }
    if (!exited) child.kill('SIGKILL');
  };

  // Reap the child even on an abrupt exit (Ctrl-C, uncaught error).
  const onExit = () => {
    if (!exited) child.kill('SIGKILL');
  };
  process.once('exit', onExit);

  const deadline = Date.now() + bootTimeoutMs;
  let lastError = null;
  while (Date.now() < deadline) {
    if (exited) {
      await stop();
      throw new Error(
        `MCP server exited before it was ready (code=${exited.code} signal=${exited.signal})${
          stderrTail ? `: ${stderrTail.trim().slice(0, 300)}` : ''
        }`,
      );
    }
    try {
      const client = await new McpHttpClient({ url, timeoutMs: 15_000 }).initialize();
      log(`mcp server ready on port ${port}`);
      return {
        client,
        url,
        stop: async () => {
          process.removeListener('exit', onExit);
          await stop();
        },
      };
    } catch (error) {
      lastError = error;
      await new Promise((resolve) => setTimeout(resolve, 300));
    }
  }

  await stop();
  throw new Error(`MCP server did not become ready within ${bootTimeoutMs}ms: ${lastError?.message ?? 'no response'}`);
}

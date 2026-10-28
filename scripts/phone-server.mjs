#!/usr/bin/env node
import http from "node:http";
import path from "node:path";
import { readFile, stat } from "node:fs/promises";
import { timingSafeEqual } from "node:crypto";
import { fileURLToPath } from "node:url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

try {
  process.loadEnvFile(path.join(ROOT, ".env"));
} catch {}

const HOST = process.env.PHONE_HOST || "127.0.0.1";
const PORT = Number(process.env.PHONE_PORT || 8787);
const TOKEN = process.env.PHONE_TOKEN || "";
const OPENCODE_URL = (process.env.OPENCODE_URL || "http://127.0.0.1:4096").replace(/\/+$/, "");
const KEEP_ALIVE_MS = Number(process.env.SESSION_KEEP_ALIVE_SECONDS || 300) * 1000;
const AGENT = process.env.PHONE_AGENT || "iphone-agent";
const STATUS_RECHECK_MS = 5000;
const SNAPSHOT_FILE = path.join(ROOT, "context", "snapshot.md");
const MAX_CONTEXT_CHARS = 30000;

const state = {
  sessionId: null,
  queue: [],
  pendingText: "",
  pendingPartId: null,
  status: "done",
  turnActive: false,
  lastInteractionAt: 0,
  lastEventAt: 0,
  assistantMessages: new Set(),
  sseConnected: false,
};

let stopped = false;

function log(...args) {
  console.log(new Date().toISOString(), ...args);
}

function json(res, status, body) {
  const payload = JSON.stringify(body);
  res.writeHead(status, {
    "content-type": "application/json",
    "content-length": Buffer.byteLength(payload),
    "cache-control": "no-store",
  });
  res.end(payload);
}

function getToken(req, url) {
  const header = req.headers["x-ask-token"];
  if (typeof header === "string" && header) return header;
  const auth = req.headers.authorization;
  if (typeof auth === "string" && auth.toLowerCase().startsWith("bearer ")) return auth.slice(7);
  return url.searchParams.get("token") || "";
}

function authorized(req, url) {
  const provided = getToken(req, url);
  if (!provided || provided.length !== TOKEN.length) return false;
  try {
    return timingSafeEqual(Buffer.from(provided), Buffer.from(TOKEN));
  } catch {
    return false;
  }
}

async function readBody(req) {
  const chunks = [];
  let size = 0;
  for await (const chunk of req) {
    size += chunk.length;
    if (size > 1_000_000) throw new Error("body too large");
    chunks.push(chunk);
  }
  return Buffer.concat(chunks).toString("utf8");
}

function extractText(raw, req, url) {
  const query = url.searchParams.get("text") ?? url.searchParams.get("message");
  if (query) return query;
  const contentType = String(req.headers["content-type"] || "");
  if (contentType.includes("application/x-www-form-urlencoded")) {
    const params = new URLSearchParams(raw);
    return params.get("text") ?? params.get("message") ?? "";
  }
  const trimmed = raw.trim();
  if (!trimmed) return "";
  if (trimmed.startsWith("{") || trimmed.startsWith("[")) {
    try {
      const parsed = JSON.parse(trimmed);
      if (typeof parsed === "string") return parsed;
      if (parsed && typeof parsed.text === "string") return parsed.text;
      if (parsed && typeof parsed.message === "string") return parsed.message;
    } catch {}
  }
  return raw;
}

function flushText() {
  if (state.pendingText.trim()) {
    state.queue.push({ text: state.pendingText });
  }
  state.pendingText = "";
  state.pendingPartId = null;
}

function finishTurn(errorText) {
  if (!state.turnActive) return;
  flushText();
  if (errorText) state.queue.push({ text: errorText });
  state.status = "done";
  state.turnActive = false;
  log("turn done", state.sessionId);
}

function handleEvent(event) {
  const p = event.properties || {};
  const sid = p.sessionID || p.info?.sessionID || p.part?.sessionID;
  if (!sid || sid !== state.sessionId) return;
  if (p.info?.role === "assistant" && p.info.id) {
    state.assistantMessages.add(p.info.id);
  }
  if (!state.turnActive) return;
  state.lastEventAt = Date.now();
  switch (event.type) {
    case "message.part.delta":
      if (p.field !== "text") return;
      if (!state.assistantMessages.has(p.messageID)) return;
      if (state.pendingPartId && state.pendingPartId !== p.partID) flushText();
      state.pendingPartId = p.partID;
      state.pendingText += p.delta || "";
      break;
    case "session.idle":
      finishTurn();
      break;
    case "session.status":
      if (p.status?.type === "idle") finishTurn();
      break;
    case "session.error":
      finishTurn("The agent hit an error. Check the Mac mini if it keeps happening.");
      break;
  }
}

async function eventLoop() {
  while (!stopped) {
    try {
      const res = await fetch(`${OPENCODE_URL}/event`, {
        headers: { accept: "text/event-stream" },
      });
      if (!res.ok || !res.body) throw new Error(`HTTP ${res.status}`);
      state.sseConnected = true;
      log("event stream connected");
      const reader = res.body.getReader();
      const decoder = new TextDecoder();
      let buffer = "";
      while (!stopped) {
        const { value, done } = await reader.read();
        if (done) break;
        buffer += decoder.decode(value, { stream: true });
        let index;
        while ((index = buffer.search(/\r?\n\r?\n/)) !== -1) {
          const match = buffer.match(/\r?\n\r?\n/);
          const frame = buffer.slice(0, index);
          buffer = buffer.slice(index + match[0].length);
          const data = frame
            .split(/\r?\n/)
            .filter((line) => line.startsWith("data:"))
            .map((line) => line.slice(5).trimStart())
            .join("\n");
          if (!data) continue;
          try {
            handleEvent(JSON.parse(data));
          } catch (err) {
            log("bad event", err.message);
          }
        }
      }
    } catch (err) {
      log("event stream error", err.message);
    }
    state.sseConnected = false;
    if (stopped) break;
    await new Promise((resolve) => setTimeout(resolve, 1000));
  }
}

async function refreshStatus() {
  if (!state.sessionId) return;
  try {
    const res = await fetch(`${OPENCODE_URL}/session/status`);
    if (!res.ok) return;
    const statuses = await res.json();
    const current = statuses[state.sessionId];
    if (!current || current.type === "idle") {
      if (state.turnActive) finishTurn();
    } else if (current.type === "busy" || current.type === "retry") {
      state.status = "working";
    }
  } catch {}
}

async function ensureSession(title) {
  const now = Date.now();
  const reuse = state.sessionId && now - state.lastInteractionAt <= KEEP_ALIVE_MS;
  state.lastInteractionAt = now;
  if (reuse) return { sessionId: state.sessionId, reused: true };

  if (state.sessionId) {
    try {
      await fetch(`${OPENCODE_URL}/session/${state.sessionId}/abort`, { method: "POST" });
    } catch {}
  }

  const res = await fetch(`${OPENCODE_URL}/session`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ title: `Phone: ${title.slice(0, 60)}` }),
  });
  if (!res.ok) throw new Error(`create session ${res.status}: ${await res.text()}`);
  const session = await res.json();
  state.sessionId = session.id;
  state.status = "done";
  state.turnActive = false;
  state.queue = [];
  state.pendingText = "";
  state.pendingPartId = null;
  state.assistantMessages.clear();
  log("new session", state.sessionId);
  return { sessionId: state.sessionId, reused: false };
}

async function handleAsk(req, res, url) {
  let raw = "";
  try {
    raw = await readBody(req);
  } catch {
    json(res, 413, { conversation: "error", error: "body too large" });
    return;
  }
  const text = extractText(raw, req, url).trim();

  if (!text) {
    state.queue.push({ text: "I didn't catch that." });
    state.status = "done";
    state.turnActive = false;
    json(res, 200, { conversation: state.sessionId || "none" });
    return;
  }

  let session;
  try {
    session = await ensureSession(text);
  } catch (err) {
    log("ensureSession failed", err.message);
    state.queue.push({ text: "The agent service is not reachable on the Mac mini." });
    state.status = "done";
    state.turnActive = false;
    json(res, 200, { conversation: "error" });
    return;
  }

  const sid = session.sessionId;
  state.queue = [];
  state.pendingText = "";
  state.pendingPartId = null;
  state.assistantMessages.clear();
  state.status = "working";
  state.turnActive = true;
  state.lastEventAt = Date.now();

  let snapshot = null;
  if (!session.reused) {
    try {
      const [snapshotText, snapshotStat] = await Promise.all([readFile(SNAPSHOT_FILE, "utf8"), stat(SNAPSHOT_FILE)]);
      snapshot = {
        text: snapshotText.slice(0, MAX_CONTEXT_CHARS),
        ageMs: Date.now() - snapshotStat.mtimeMs,
      };
    } catch (err) {
      log("snapshot unavailable", err.message);
    }
  }
  const promptText = snapshot
    ? `<context>\n${snapshot.text}\n</context>\n\nUser request: ${text}`
    : text;
  log(
    "ask",
    sid,
    `${text.length} chars`,
    session.reused ? "reused" : "new",
    snapshot ? `context=${snapshot.text.length} chars age=${Math.round(snapshot.ageMs / 1000)}s` : "no context",
  );

  try {
    const r = await fetch(`${OPENCODE_URL}/session/${sid}/prompt_async`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ agent: AGENT, parts: [{ type: "text", text: promptText }] }),
    });
    if (!r.ok) throw new Error(`prompt_async ${r.status}: ${await r.text()}`);
  } catch (err) {
    log("prompt failed", err.message);
    state.queue.push({ text: "The agent failed to start. Check the Mac mini." });
    state.status = "done";
    state.turnActive = false;
  }

  json(res, 200, { conversation: sid });
}

async function handleReply(req, res) {
  state.lastInteractionAt = Date.now();
  if (state.turnActive && Date.now() - state.lastEventAt > STATUS_RECHECK_MS) {
    await refreshStatus();
  }
  if (!state.sessionId && state.queue.length === 0) {
    json(res, 200, { chunks: [{ text: "No active conversation." }], status: "done" });
    return;
  }
  flushText();
  const chunks = state.queue.splice(0);
  json(res, 200, { chunks, status: state.status });
}

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, `http://${req.headers.host || "localhost"}`);
  if (req.method === "GET" && url.pathname === "/health") {
    json(res, 200, { ok: true, opencode: state.sseConnected, status: state.status });
    return;
  }
  if (!authorized(req, url)) {
    json(res, 401, { error: "unauthorized" });
    return;
  }
  if (req.method === "POST" && url.pathname === "/ask") {
    await handleAsk(req, res, url);
    return;
  }
  if (req.method === "GET" && url.pathname === "/reply") {
    await handleReply(req, res);
    return;
  }
  json(res, 404, { error: "not found" });
});

if (!TOKEN) {
  console.error("PHONE_TOKEN is not set in .env");
  process.exit(1);
}

eventLoop();
server.listen(PORT, HOST, () => log(`phone server listening on http://${HOST}:${PORT}`));

for (const signal of ["SIGINT", "SIGTERM"]) {
  process.on(signal, () => {
    stopped = true;
    server.close(() => process.exit(0));
    setTimeout(() => process.exit(0), 2000).unref();
  });
}

#!/usr/bin/env node
import http from "node:http";
import { execFile } from "node:child_process";
import { readFile, writeFile, mkdir } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const TOKEN_FILE = join(ROOT, ".zoho", "tokens.json");
const REDIRECT_URI = "http://localhost:8080/callback";
const ACCOUNTS_URL = "https://accounts.zoho.com";
const MAIL_URL = "https://mail.zoho.com";
const SCOPES = [
  "ZohoMail.accounts.READ",
  "ZohoMail.messages.READ",
  "ZohoMail.messages.CREATE",
  "ZohoMail.folders.READ",
];

async function loadEnv() {
  const raw = await readFile(join(ROOT, ".env"), "utf8");
  const env = {};
  for (const line of raw.split("\n")) {
    const match = line.match(/^\s*([A-Z0-9_]+)\s*=\s*(.*)\s*$/);
    if (match) env[match[1]] = match[2].replace(/^["']|["']$/g, "");
  }
  return env;
}

async function postForm(url, params) {
  const res = await fetch(url, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams(params),
  });
  const json = await res.json();
  if (json.error) throw new Error(`${json.error}: ${json.error_description ?? ""}`);
  return json;
}

async function saveTokens(tokens) {
  await mkdir(dirname(TOKEN_FILE), { recursive: true });
  await writeFile(TOKEN_FILE, JSON.stringify(tokens, null, 2), { mode: 0o600 });
}

async function auth() {
  const env = await loadEnv();
  if (!env.ZOHO_CLIENT_ID || !env.ZOHO_CLIENT_SECRET) {
    throw new Error("ZOHO_CLIENT_ID / ZOHO_CLIENT_SECRET missing from .env");
  }

  const authUrl =
    `${ACCOUNTS_URL}/oauth/v2/auth?` +
    new URLSearchParams({
      scope: SCOPES.join(","),
      client_id: env.ZOHO_CLIENT_ID,
      response_type: "code",
      redirect_uri: REDIRECT_URI,
      access_type: "offline",
      prompt: "consent",
    });

  const code = await new Promise((resolve, reject) => {
    const server = http.createServer((req, res) => {
      const url = new URL(req.url, REDIRECT_URI);
      if (url.pathname !== "/callback") {
        res.writeHead(404).end();
        return;
      }
      const grantCode = url.searchParams.get("code");
      const error = url.searchParams.get("error");
      res.writeHead(200, { "Content-Type": "text/html" });
      res.end(
        `<h2>${grantCode ? "Authorized. You can close this tab." : `Error: ${error}`}</h2>`,
      );
      server.close();
      grantCode ? resolve(grantCode) : reject(new Error(error ?? "no code"));
    });
    server.listen(8080, "127.0.0.1", () => {
      console.log(`Listening on ${REDIRECT_URI}`);
      console.log(`Open this URL to authorize:\n\n${authUrl}\n`);
      execFile("open", [authUrl.toString()]);
    });
    server.on("error", reject);
    setTimeout(() => {
      server.close();
      reject(new Error("Timed out after 5 minutes waiting for callback"));
    }, 5 * 60 * 1000).unref();
  });

  const tokens = await postForm(`${ACCOUNTS_URL}/oauth/v2/token`, {
    grant_type: "authorization_code",
    client_id: env.ZOHO_CLIENT_ID,
    client_secret: env.ZOHO_CLIENT_SECRET,
    redirect_uri: REDIRECT_URI,
    code,
  });
  tokens.obtained_at = Date.now();
  await saveTokens(tokens);
  console.log(`Saved tokens to ${TOKEN_FILE}`);
}

async function getAccessToken() {
  const env = await loadEnv();
  const tokens = JSON.parse(await readFile(TOKEN_FILE, "utf8"));
  if (tokens.access_token && Date.now() - tokens.obtained_at < 55 * 60 * 1000) {
    return tokens.access_token;
  }
  if (!tokens.refresh_token) throw new Error("No refresh token; run `auth` again");
  const refreshed = await postForm(`${ACCOUNTS_URL}/oauth/v2/token`, {
    grant_type: "refresh_token",
    client_id: env.ZOHO_CLIENT_ID,
    client_secret: env.ZOHO_CLIENT_SECRET,
    refresh_token: tokens.refresh_token,
  });
  await saveTokens({
    ...tokens,
    ...refreshed,
    refresh_token: refreshed.refresh_token ?? tokens.refresh_token,
    obtained_at: Date.now(),
  });
  return refreshed.access_token;
}

async function apiRequest(method, path, body) {
  const token = await getAccessToken();
  const res = await fetch(`${MAIL_URL}${path}`, {
    method,
    headers: {
      Authorization: `Zoho-oauthtoken ${token}`,
      ...(body ? { "Content-Type": "application/json" } : {}),
    },
    ...(body ? { body: JSON.stringify(body) } : {}),
  });
  const json = await res.json();
  if (!res.ok || json.status?.code !== 200) {
    throw new Error(`Mail API ${res.status}: ${JSON.stringify(json).slice(0, 500)}`);
  }
  return json;
}

const apiGet = (path) => apiRequest("GET", path);

async function getAccount() {
  const accounts = await apiGet("/api/accounts");
  return accounts.data[0];
}

async function listAccounts() {
  const accounts = await apiGet("/api/accounts");
  console.log(JSON.stringify(accounts.data, null, 2));
}

async function findFolder(accountId, name) {
  const folders = await apiGet(`/api/accounts/${accountId}/folders`);
  const folder = folders.data.find(
    (f) => f.folderName.toLowerCase() === name.toLowerCase(),
  );
  if (!folder) {
    console.log("Folders:", folders.data.map((f) => f.folderName).join(", "));
    throw new Error(`Folder "${name}" not found`);
  }
  return folder;
}

async function getMessageHeader(messageId, folderName = "Inbox") {
  const account = await getAccount();
  const folder = await findFolder(account.accountId, folderName);
  return apiGet(
    `/api/accounts/${account.accountId}/folders/${folder.folderId}/messages/${messageId}/header`,
  );
}

async function getMessageContent(messageId, folderName = "Inbox") {
  const account = await getAccount();
  const folder = await findFolder(account.accountId, folderName);
  return apiGet(
    `/api/accounts/${account.accountId}/folders/${folder.folderId}/messages/${messageId}/content`,
  );
}

async function createDraft({ to, subject, content, from, inReplyTo, refHeader }) {
  const account = await getAccount();
  const fromAddress = from ?? account.primaryEmailAddress;
  const res = await apiRequest("POST", `/api/accounts/${account.accountId}/messages`, {
    mode: "draft",
    fromAddress,
    toAddress: to,
    subject,
    content,
    mailFormat: "plaintext",
    ...(inReplyTo ? { inReplyTo } : {}),
    ...(refHeader ? { refHeader } : {}),
  });
  console.log(`Draft saved from ${fromAddress} to ${to}: ${JSON.stringify(res.data)}`);
}

async function read({ limit = 10, folder = "Inbox" } = {}) {
  const account = await getAccount();
  console.log(`Account: ${account.primaryEmailAddress} (${account.accountId})`);

  const folders = await apiGet(`/api/accounts/${account.accountId}/folders`);
  const target = folders.data.find(
    (f) => f.folderName.toLowerCase() === folder.toLowerCase(),
  );
  if (!target) {
    console.log("Folders:", folders.data.map((f) => f.folderName).join(", "));
    throw new Error(`Folder "${folder}" not found`);
  }

  const messages = await apiGet(
    `/api/accounts/${account.accountId}/messages/view?folderId=${target.folderId}&limit=${limit}`,
  );
  console.log(`\n${target.folderName} — ${messages.data.length} message(s):\n`);
  for (const m of messages.data) {
    console.log(
      `- ${m.receivedTime ?? m.sentDateInGMT} | ${m.fromAddress} | id=${m.messageId}`,
    );
    console.log(`  ${m.subject}`);
    console.log(`  summary: ${(m.summary ?? "").slice(0, 120)}`);
  }
}

const [command, ...args] = process.argv.slice(2);
const options = Object.fromEntries(
  args.map((a) => {
    const arg = a.replace(/^--/, "");
    const eq = arg.indexOf("=");
    return eq === -1 ? [arg, true] : [arg.slice(0, eq), arg.slice(eq + 1)];
  }),
);

if (command === "auth") {
  await auth();
  await read({ limit: 5 });
} else if (command === "read") {
  await read({ limit: Number(options.limit ?? 10), folder: options.folder ?? "Inbox" });
} else if (command === "draft") {
  await createDraft({
    to: options.to,
    subject: options.subject,
    content: options.content,
    from: options.from,
    inReplyTo: options.inReplyTo,
    refHeader: options.refHeader,
  });
} else if (command === "header") {
  console.log(
    JSON.stringify(
      await getMessageHeader(options.id, options.folder ?? "Inbox"),
      null,
      2,
    ),
  );
} else if (command === "message") {
  console.log(
    JSON.stringify(
      await getMessageContent(options.id, options.folder ?? "Inbox"),
      null,
      2,
    ),
  );
} else if (command === "accounts") {
  await listAccounts();
} else {
  console.log(
    "Usage: node scripts/zoho.mjs auth | read [--limit=10] [--folder=Inbox] | " +
      "draft --to=... [--subject=...] [--content=...] [--from=...] | " +
      "header --id=... [--folder=Inbox] | accounts",
  );
  process.exit(1);
}

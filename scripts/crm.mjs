#!/usr/bin/env node
import { readFile, writeFile, rename } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { parse } from "csv-parse/sync";
import { stringify } from "csv-stringify/sync";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const CRM_DIR = process.env.CRM_DIR ? path.resolve(process.env.CRM_DIR) : path.join(ROOT, "crm");
const CONTACTS_FILE = path.join(CRM_DIR, "contacts.csv");
const INTERACTIONS_FILE = path.join(CRM_DIR, "interactions.csv");
const CONTACT_COLUMNS = [
  "contact_id",
  "name",
  "org",
  "title",
  "phone",
  "email",
  "linkedin",
  "source",
  "first_met",
  "stage",
  "tags",
  "notes",
];
const INTERACTION_COLUMNS = [
  "interaction_id",
  "contact_id",
  "date",
  "channel",
  "summary",
  "next_step",
  "next_step_date",
];
const STAGES = new Set(["new", "contacted", "warm", "meeting", "proposal", "won", "lost", "dormant"]);
const CHANNELS = new Set(["call", "email", "text", "in-person", "event", "linkedin", "intro", "other"]);
const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;

function today() {
  const now = new Date();
  return `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, "0")}-${String(now.getDate()).padStart(2, "0")}`;
}

async function readCsv(file, columns) {
  const raw = await readFile(file, "utf8");
  const rows = parse(raw, { columns: true, skip_empty_lines: true, bom: true });
  for (const row of rows) {
    for (const column of columns) {
      if (row[column] == null) row[column] = "";
    }
  }
  return rows;
}

async function writeCsv(file, columns, rows) {
  const data = stringify(rows, { header: true, columns });
  const tmp = `${file}.tmp`;
  await writeFile(tmp, data, { mode: 0o600 });
  await rename(tmp, file);
}

async function load() {
  const [contacts, interactions] = await Promise.all([
    readCsv(CONTACTS_FILE, CONTACT_COLUMNS),
    readCsv(INTERACTIONS_FILE, INTERACTION_COLUMNS),
  ]);
  return { contacts, interactions };
}

function nextId(rows, column, prefix) {
  let max = 0;
  for (const row of rows) {
    const value = String(row[column] || "");
    const match = value.match(new RegExp(`^${prefix}(\\d+)$`));
    if (match) max = Math.max(max, Number(match[1]));
  }
  return `${prefix}${String(max + 1).padStart(4, "0")}`;
}

function matchContact(contacts, idOrName) {
  const term = String(idOrName || "").toLowerCase();
  const exact = contacts.find(
    (contact) =>
      contact.contact_id.toLowerCase() === term ||
      contact.name.toLowerCase() === term ||
      contact.email.toLowerCase() === term ||
      contact.phone.toLowerCase() === term,
  );
  if (exact) return exact;
  const partial = contacts.filter(
    (contact) =>
      contact.name.toLowerCase().includes(term) ||
      contact.org.toLowerCase().includes(term) ||
      contact.email.toLowerCase().includes(term) ||
      contact.phone.toLowerCase().includes(term),
  );
  if (partial.length === 1) return partial[0];
  if (partial.length > 1) {
    throw new Error(`Ambiguous contact "${idOrName}": ${partial.map((contact) => contact.contact_id + " " + contact.name).join(", ")}`);
  }
  throw new Error(`Contact not found: ${idOrName}`);
}

function latestInteraction(interactions, contactId) {
  return interactions
    .filter((interaction) => interaction.contact_id === contactId)
    .sort((a, b) => {
      const date = String(a.date).localeCompare(String(b.date));
      if (date !== 0) return date;
      return String(a.interaction_id).localeCompare(String(b.interaction_id));
    })
    .at(-1);
}

function daysBetween(from, to) {
  const start = Date.parse(`${from}T00:00:00Z`);
  const end = Date.parse(`${to}T00:00:00Z`);
  if (!Number.isFinite(start) || !Number.isFinite(end)) return null;
  return Math.round((end - start) / 864e5);
}

export async function dueContacts(onDate = today()) {
  const { contacts, interactions } = await load();
  const due = [];
  for (const contact of contacts) {
    const latest = latestInteraction(interactions, contact.contact_id);
    if (!latest || !latest.next_step || !latest.next_step_date) continue;
    if (latest.next_step_date > onDate) continue;
    due.push({
      contact_id: contact.contact_id,
      name: contact.name,
      org: contact.org,
      title: contact.title,
      phone: contact.phone,
      email: contact.email,
      stage: contact.stage,
      tags: contact.tags,
      notes: contact.notes,
      next_step: latest.next_step,
      next_step_date: latest.next_step_date,
      overdue_days: daysBetween(latest.next_step_date, onDate),
      last_interaction: {
        date: latest.date,
        channel: latest.channel,
        summary: latest.summary,
      },
    });
  }
  return due.sort((a, b) => a.next_step_date.localeCompare(b.next_step_date));
}

export async function listContacts() {
  const { contacts } = await load();
  return contacts.slice().sort((a, b) => a.name.localeCompare(b.name));
}

export async function showContact(idOrName) {
  const { contacts, interactions } = await load();
  const contact = matchContact(contacts, idOrName);
  const history = interactions
    .filter((interaction) => interaction.contact_id === contact.contact_id)
    .sort((a, b) => String(b.date).localeCompare(String(a.date)));
  return { ...contact, interactions: history };
}

export async function searchContacts(term) {
  const needle = String(term || "").toLowerCase();
  const { contacts } = await load();
  return contacts
    .filter((contact) =>
      [contact.name, contact.org, contact.title, contact.email, contact.phone, contact.tags, contact.notes]
        .filter(Boolean)
        .some((value) => String(value).toLowerCase().includes(needle)),
    )
    .sort((a, b) => a.name.localeCompare(b.name));
}

export async function addContact(fields = {}) {
  const { contacts } = await load();
  if (!fields.name) throw new Error("--name is required");
  const stage = (fields.stage || "new").toLowerCase();
  if (!STAGES.has(stage)) throw new Error(`Invalid stage: ${stage}`);
  const contact = {
    contact_id: nextId(contacts, "contact_id", "c"),
    name: fields.name,
    org: fields.org || "",
    title: fields.title || "",
    phone: fields.phone || "",
    email: fields.email || "",
    linkedin: fields.linkedin || "",
    source: fields.source || "",
    first_met: fields["first-met"] || today(),
    stage,
    tags: fields.tags || "",
    notes: fields.notes || "",
  };
  contacts.push(contact);
  await writeCsv(CONTACTS_FILE, CONTACT_COLUMNS, contacts);
  return contact;
}

export async function updateContact(id, fields = {}) {
  const { contacts } = await load();
  const contact = matchContact(contacts, id);
  const allowed = ["name", "org", "title", "phone", "email", "linkedin", "source", "first_met", "stage", "tags", "notes"];
  for (const [key, value] of Object.entries(fields)) {
    const column = key === "first-met" ? "first_met" : key;
    if (!allowed.includes(column) || value == null || value === true) continue;
    if (column === "stage" && !STAGES.has(String(value).toLowerCase())) {
      throw new Error(`Invalid stage: ${value}`);
    }
    contact[column] = column === "stage" ? String(value).toLowerCase() : String(value);
  }
  await writeCsv(CONTACTS_FILE, CONTACT_COLUMNS, contacts);
  return contact;
}

export async function logInteraction(id, fields = {}) {
  const { contacts, interactions } = await load();
  const contact = matchContact(contacts, id);
  const channel = (fields.channel || "text").toLowerCase();
  if (!CHANNELS.has(channel)) throw new Error(`Invalid channel: ${channel}`);
  if (!fields.summary) throw new Error("--summary is required");
  const date = fields.date || today();
  if (!DATE_RE.test(date)) throw new Error(`Invalid date: ${date}`);
  if (fields["next-date"] && !DATE_RE.test(fields["next-date"])) {
    throw new Error(`Invalid next date: ${fields["next-date"]}`);
  }
  const interaction = {
    interaction_id: nextId(interactions, "interaction_id", "i"),
    contact_id: contact.contact_id,
    date,
    channel,
    summary: fields.summary,
    next_step: fields["next-step"] || "",
    next_step_date: fields["next-date"] || "",
  };
  interactions.push(interaction);
  await writeCsv(INTERACTIONS_FILE, INTERACTION_COLUMNS, interactions);
  return interaction;
}

function parseArgs(argv) {
  const positional = [];
  const options = {};
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (!arg.startsWith("--")) {
      positional.push(arg);
      continue;
    }
    const eq = arg.indexOf("=");
    if (eq !== -1) {
      options[arg.slice(2, eq)] = arg.slice(eq + 1);
      continue;
    }
    const key = arg.slice(2);
    const next = argv[i + 1];
    if (next && !next.startsWith("--")) {
      options[key] = next;
      i++;
    } else {
      options[key] = true;
    }
  }
  return { positional, options };
}

async function main() {
  const [command, ...rest] = process.argv.slice(2);
  const { positional, options } = parseArgs(rest);
  const print = (value) => console.log(JSON.stringify(value));

  if (command === "list") {
    print(await listContacts());
    return;
  }
  if (command === "show") {
    print(await showContact(positional[0] || options.id));
    return;
  }
  if (command === "search") {
    print(await searchContacts(positional[0] || options.search));
    return;
  }
  if (command === "due") {
    print(await dueContacts(options.date || today()));
    return;
  }
  if (command === "add") {
    print(await addContact(options));
    return;
  }
  if (command === "update") {
    print(await updateContact(positional[0] || options.id, options));
    return;
  }
  if (command === "log") {
    print(await logInteraction(positional[0] || options.id, options));
    return;
  }
  throw new Error("Usage: crm.mjs list | show <id|name> | search <term> | due | add | update <id> | log <id>");
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().catch((err) => {
    console.error(JSON.stringify({ ok: false, error: err.message }));
    process.exitCode = 1;
  });
}

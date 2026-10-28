#!/usr/bin/env node
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { randomUUID } from "node:crypto";
import { createDAVClient } from "tsdav";
import vcf from "vcf";

const execFileAsync = promisify(execFile);
const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const EKCTL = path.join(ROOT, "bin", "ekctl");
const DEFAULT_EVENT_CALENDARS = ["Business", "Personal", "Humana"];
const DEFAULT_REMINDER_LISTS = ["Business", "Personal", "Humana"];
const HISTORY_DAYS = 30;
const FUTURE_DAYS = 180;
const CONTACTS_TTL_MS = 5 * 60 * 1000;
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

try {
  process.loadEnvFile(path.join(ROOT, ".env"));
} catch {}

let calendarCache = null;
let contactsClient = null;
let addressBookCache = null;
let contactsCache = null;
let contactsCacheAt = 0;

async function runEkctl(args) {
  try {
    const { stdout } = await execFileAsync(EKCTL, args, { maxBuffer: 32 * 1024 * 1024 });
    return parseEkctl(stdout);
  } catch (err) {
    if (err.stdout) {
      try {
        return parseEkctl(err.stdout);
      } catch {}
    }
    throw new Error(err.message);
  }
}

function parseEkctl(stdout) {
  let data;
  try {
    data = JSON.parse(stdout);
  } catch {
    throw new Error(`ekctl returned non-JSON: ${stdout.slice(0, 500)}`);
  }
  if (data.status === "error") throw new Error(data.error || "ekctl error");
  return data;
}

async function getCalendars(force = false) {
  if (!calendarCache || force) {
    const data = await runEkctl(["list", "calendars"]);
    calendarCache = data.calendars || [];
  }
  return calendarCache;
}

function resolveCalendar(name, type = "event") {
  const calendars = calendarCache || [];
  if (UUID_RE.test(name)) return name;
  const match = calendars.find(
    (calendar) => calendar.type === type && calendar.title.toLowerCase() === String(name).toLowerCase(),
  );
  if (!match) {
    const available = calendars
      .filter((calendar) => calendar.type === type)
      .map((calendar) => calendar.title)
      .join(", ");
    throw new Error(`${type === "event" ? "Calendar" : "Reminder list"} "${name}" not found. Available: ${available}`);
  }
  return match.id;
}

function resolveCalendars(names, type = "event") {
  return names.map((name) => resolveCalendar(name, type));
}

function compactEvent(event) {
  return {
    id: event.id,
    title: event.title,
    calendar: event.calendar?.title || null,
    start: event.startDate,
    end: event.endDate,
    allDay: event.allDay,
    location: event.location,
    notes: event.notes,
    recurring: event.hasRecurrenceRules,
    occurrence: event.occurrenceDate || null,
  };
}

function compactReminder(reminder) {
  return {
    id: reminder.id,
    title: reminder.title,
    list: reminder.list?.title || null,
    due: reminder.dueDate || null,
    completed: reminder.completed,
    priority: reminder.priority,
    notes: reminder.notes,
  };
}

function compactContact(contact) {
  return {
    id: contact.id,
    name: contact.name,
    firstName: contact.firstName,
    lastName: contact.lastName,
    org: contact.org,
    title: contact.title,
    phones: contact.phones,
    emails: contact.emails,
    note: contact.note,
  };
}

export async function listEvents({
  from,
  to,
  calendars = DEFAULT_EVENT_CALENDARS,
  search,
  availability,
} = {}) {
  await getCalendars();
  const start = from ? String(from) : new Date(Date.now() - HISTORY_DAYS * 864e5).toISOString();
  const end = to ? String(to) : new Date(Date.now() + FUTURE_DAYS * 864e5).toISOString();
  const ids = resolveCalendars(calendars, "event");
  const args = ["list", "events", "--calendar", ids.join(","), `--from=${start}`, `--to=${end}`];
  if (search) args.push("--search", search);
  if (availability) args.push("--availability", availability);
  const data = await runEkctl(args);
  return (data.events || []).map(compactEvent);
}

export async function addEvent({
  calendar = "Business",
  title,
  start,
  end,
  allDay,
  location,
  notes,
  url,
  availability,
  alarms,
  travelTime,
  recurrence,
} = {}) {
  if (!title || !start || !end) throw new Error("title, start, and end are required");
  await getCalendars();
  const id = resolveCalendar(calendar, "event");
  const args = ["add", "event", "--calendar", id, "--title", title, "--start", start, "--end", end];
  if (allDay) args.push("--all-day");
  if (location) args.push("--location", location);
  if (notes) args.push("--notes", notes);
  if (url) args.push("--url", url);
  if (availability) args.push("--availability", availability);
  if (alarms) args.push("--alarms", alarms);
  if (travelTime != null) args.push("--travel-time", String(travelTime));
  addRecurrenceArgs(args, recurrence);
  const data = await runEkctl(args);
  return data.event ? compactEvent(data.event) : data;
}

export async function updateEvent({
  id,
  occurrence,
  span,
  calendar,
  title,
  start,
  end,
  allDay,
  location,
  notes,
  url,
  availability,
  alarms,
  addAlarms,
  travelTime,
  recurrence,
} = {}) {
  if (!id) throw new Error("event id is required");
  await getCalendars();
  const args = ["update", "event", id];
  if (occurrence) args.push("--occurrence", occurrence);
  if (span) args.push("--span", span);
  if (calendar) args.push("--calendar", resolveCalendar(calendar, "event"));
  if (title) args.push("--title", title);
  if (start) args.push("--start", start);
  if (end) args.push("--end", end);
  if (allDay != null) args.push("--all-day", String(allDay === true || allDay === "true"));
  if (location) args.push("--location", location);
  if (notes) args.push("--notes", notes);
  if (url) args.push("--url", url);
  if (availability) args.push("--availability", availability);
  if (alarms) args.push("--alarms", alarms);
  if (addAlarms) args.push("--add-alarms", addAlarms);
  if (travelTime != null) args.push("--travel-time", String(travelTime));
  addRecurrenceArgs(args, recurrence);
  const data = await runEkctl(args);
  return data.event ? compactEvent(data.event) : data;
}

export async function deleteEvent({ id, occurrence, span } = {}) {
  if (!id) throw new Error("event id is required");
  const args = ["delete", "event", id];
  if (occurrence) args.push("--occurrence", occurrence);
  if (span) args.push("--span", span);
  return runEkctl(args);
}

function addRecurrenceArgs(args, recurrence) {
  if (!recurrence) return;
  const map = {
    frequency: "--recurrence-frequency",
    interval: "--recurrence-interval",
    endCount: "--recurrence-end-count",
    endDate: "--recurrence-end-date",
    days: "--recurrence-days",
    months: "--recurrence-months",
    daysOfMonth: "--recurrence-days-of-month",
    weeksOfYear: "--recurrence-weeks-of-year",
    daysOfYear: "--recurrence-days-of-year",
    setPositions: "--recurrence-set-positions",
  };
  for (const [key, flag] of Object.entries(map)) {
    if (recurrence[key] != null) args.push(flag, String(recurrence[key]));
  }
}

export async function listReminders({
  lists = DEFAULT_REMINDER_LISTS,
  completed = false,
  search,
} = {}) {
  await getCalendars();
  const ids = resolveCalendars(lists, "reminder");
  const results = await Promise.all(
    ids.map(async (id) => {
      const args = ["list", "reminders", "--list", id, "--completed", String(Boolean(completed))];
      if (search) args.push("--search", search);
      const data = await runEkctl(args);
      return data.reminders || [];
    }),
  );
  return results
    .flat()
    .map(compactReminder)
    .sort((a, b) => {
      if (!a.due && !b.due) return a.title.localeCompare(b.title);
      if (!a.due) return 1;
      if (!b.due) return -1;
      return a.due.localeCompare(b.due);
    });
}

export async function addReminder({ list = "Business", title, due, notes, priority } = {}) {
  if (!title) throw new Error("title is required");
  await getCalendars();
  const id = resolveCalendar(list, "reminder");
  const args = ["add", "reminder", "--list", id, "--title", title];
  if (due) args.push("--due", due);
  if (notes) args.push("--notes", notes);
  if (priority != null) args.push("--priority", String(priority));
  const data = await runEkctl(args);
  return data.reminder ? compactReminder(data.reminder) : data;
}

export async function updateReminder({ id, title, due, notes, priority, completed } = {}) {
  if (!id) throw new Error("reminder id is required");
  const args = ["update", "reminder", id];
  if (title) args.push("--title", title);
  if (due) args.push("--due", due);
  if (notes) args.push("--notes", notes);
  if (priority != null) args.push("--priority", String(priority));
  if (completed != null) args.push("--completed", String(completed === true || completed === "true"));
  const data = await runEkctl(args);
  return data.reminder ? compactReminder(data.reminder) : data;
}

export async function completeReminder({ id } = {}) {
  if (!id) throw new Error("reminder id is required");
  return runEkctl(["complete", "reminder", id]);
}

export async function deleteReminder({ id } = {}) {
  if (!id) throw new Error("reminder id is required");
  return runEkctl(["delete", "reminder", id]);
}

async function getContactsClient() {
  if (contactsClient) return contactsClient;
  if (!process.env.ICLOUD_EMAIL || !process.env.ICLOUD_APP_PASSWORD) {
    throw new Error("ICLOUD_EMAIL and ICLOUD_APP_PASSWORD are required for contacts");
  }
  contactsClient = await createDAVClient({
    serverUrl: "https://contacts.icloud.com",
    credentials: {
      username: process.env.ICLOUD_EMAIL,
      password: process.env.ICLOUD_APP_PASSWORD,
    },
    authMethod: "Basic",
    defaultAccountType: "carddav",
  });
  return contactsClient;
}

async function getAddressBook() {
  if (addressBookCache) return addressBookCache;
  const client = await getContactsClient();
  const books = await client.fetchAddressBooks();
  if (!books.length) throw new Error("No iCloud address book found");
  addressBookCache = books[0];
  return addressBookCache;
}

function parseVCard(raw, url, etag) {
  const card = new vcf().parse(raw);
  const jcard = card.toJSON();
  const props = {};
  for (const entry of jcard[1]) {
    const [name, params, type, value] = entry;
    (props[name] ||= []).push({ params, type, value });
  }
  const first = (name) => props[name]?.[0]?.value;
  const all = (name) => (props[name] || []).map((entry) => entry.value).filter(Boolean);
  const n = first("n");
  const name = first("fn") || [n?.[1], n?.[0]].filter(Boolean).join(" ") || "";
  const uid = first("uid") || path.basename(url, ".vcf");
  return {
    id: uid,
    name,
    firstName: n?.[1] || "",
    lastName: n?.[0] || "",
    org: first("org") || "",
    title: first("title") || "",
    phones: all("tel"),
    emails: all("email"),
    note: first("note") || "",
    url,
    etag,
    raw,
  };
}

export async function listContacts({ refresh = false, search, limit = 20 } = {}) {
  const now = Date.now();
  if (!contactsCache || refresh || now - contactsCacheAt > CONTACTS_TTL_MS) {
    const client = await getContactsClient();
    const addressBook = await getAddressBook();
    const cards = await client.fetchVCards({ addressBook });
    contactsCache = cards.map((card) => parseVCard(card.data, card.url, card.etag));
    contactsCacheAt = now;
  }
  let contacts = contactsCache;
  if (search) {
    const term = String(search).toLowerCase();
    contacts = contacts.filter((contact) =>
      [contact.name, contact.org, contact.title, contact.note, ...contact.phones, ...contact.emails]
        .filter(Boolean)
        .some((value) => String(value).toLowerCase().includes(term)),
    );
  }
  const sorted = contacts.slice().sort((a, b) => a.name.localeCompare(b.name));
  return {
    count: sorted.length,
    contacts: sorted.slice(0, limit).map(compactContact),
  };
}

function findContactRecord(idOrTerm) {
  if (!contactsCache) return null;
  const term = String(idOrTerm).toLowerCase();
  return contactsCache.find((contact) =>
    [contact.id, contact.name, ...contact.phones, ...contact.emails]
      .filter(Boolean)
      .some((value) => String(value).toLowerCase() === term),
  );
}

function escapeVCard(value) {
  return String(value)
    .replace(/\\/g, "\\\\")
    .replace(/\n/g, "\\n")
    .replace(/;/g, "\\;")
    .replace(/,/g, "\\,");
}

function setJCardValue(jcard, name, value, params = {}) {
  const index = jcard[1].findIndex((entry) => entry[0] === name);
  const next = [name, params, "text", value];
  if (index === -1) jcard[1].push(next);
  else jcard[1][index] = next;
}

function replaceJCardValues(jcard, name, entries) {
  jcard[1] = jcard[1].filter((entry) => entry[0] !== name);
  jcard[1].push(...entries);
}

function makeVCard({ uid, firstName, lastName, name, org, title, phones, emails, note }) {
  const fn = name || [firstName, lastName].filter(Boolean).join(" ");
  const lines = [
    "BEGIN:VCARD",
    "VERSION:3.0",
    `UID:${uid}`,
    `FN:${escapeVCard(fn)}`,
    `N:${escapeVCard(lastName)};${escapeVCard(firstName)};;;`,
  ];
  if (org) lines.push(`ORG:${escapeVCard(org)}`);
  if (title) lines.push(`TITLE:${escapeVCard(title)}`);
  for (const phone of phones) lines.push(`TEL;TYPE=CELL:${escapeVCard(phone)}`);
  for (const email of emails) lines.push(`EMAIL:${escapeVCard(email)}`);
  if (note) lines.push(`NOTE:${escapeVCard(note)}`);
  lines.push("END:VCARD");
  return `${lines.join("\r\n")}\r\n`;
}

export async function addContact({
  firstName = "",
  lastName = "",
  name,
  org,
  title,
  phone,
  email,
  note,
} = {}) {
  if (!name && !firstName && !lastName) throw new Error("name or first/last name is required");
  await listContacts({ refresh: true, limit: 1 });
  const client = await getContactsClient();
  const addressBook = await getAddressBook();
  const uid = randomUUID().toUpperCase();
  const vCardString = makeVCard({
    uid,
    firstName,
    lastName,
    name,
    org,
    title,
    phones: phone ? [phone] : [],
    emails: email ? [email] : [],
    note,
  });
  await client.createVCard({ addressBook, vCardString, filename: `${uid}.vcf` });
  contactsCache = null;
  return {
    id: uid,
    name: name || [firstName, lastName].filter(Boolean).join(" "),
    org: org || "",
    phones: phone ? [phone] : [],
    emails: email ? [email] : [],
  };
}

export async function updateContact({
  id,
  firstName,
  lastName,
  name,
  org,
  title,
  phone,
  email,
  note,
} = {}) {
  if (!id) throw new Error("contact id is required");
  await listContacts({ refresh: true, limit: 1 });
  const contact = findContactRecord(id);
  if (!contact) throw new Error(`Contact not found: ${id}`);
  const client = await getContactsClient();
  const current = parseVCard(contact.raw, contact.url);
  const next = {
    firstName: firstName ?? current.firstName,
    lastName: lastName ?? current.lastName,
    name: name ?? current.name,
    org: org ?? current.org,
    title: title ?? current.title,
    phones: phone ? [phone] : current.phones,
    emails: email ? [email] : current.emails,
    note: note ?? current.note,
  };
  const jcard = new vcf().parse(contact.raw).toJSON();
  setJCardValue(jcard, "fn", next.name);
  setJCardValue(jcard, "n", [next.lastName, next.firstName, "", "", ""]);
  setJCardValue(jcard, "org", next.org);
  setJCardValue(jcard, "title", next.title);
  setJCardValue(jcard, "note", next.note);
  if (phone) replaceJCardValues(jcard, "tel", [["tel", { type: "cell" }, "text", phone]]);
  if (email) replaceJCardValues(jcard, "email", [["email", {}, "text", email]]);
  const vCardString = vcf.fromJSON(jcard).toString();
  const updated = { ...contact, data: vCardString };
  await client.updateVCard({ vCard: updated });
  contactsCache = null;
  return { id: current.id, ...next, phones: next.phones, emails: next.emails };
}

export async function deleteContact({ id } = {}) {
  if (!id) throw new Error("contact id is required");
  await listContacts({ refresh: true, limit: 1 });
  const contact = findContactRecord(id);
  if (!contact) throw new Error(`Contact not found: ${id}`);
  const client = await getContactsClient();
  await client.deleteVCard({ vCard: { ...contact, data: contact.raw } });
  contactsCache = null;
  return { deleted: contact.id, name: contact.name };
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

function listOption(value, fallback) {
  if (!value || value === true) return fallback;
  return String(value)
    .split(",")
    .map((item) => item.trim())
    .filter(Boolean);
}

function recurrenceFromOptions(options) {
  const recurrence = {};
  const map = {
    "recurrence-frequency": "frequency",
    "recurrence-interval": "interval",
    "recurrence-end-count": "endCount",
    "recurrence-end-date": "endDate",
    "recurrence-days": "days",
    "recurrence-months": "months",
    "recurrence-days-of-month": "daysOfMonth",
    "recurrence-weeks-of-year": "weeksOfYear",
    "recurrence-days-of-year": "daysOfYear",
    "recurrence-set-positions": "setPositions",
  };
  for (const [flag, key] of Object.entries(map)) {
    if (options[flag] != null) recurrence[key] = options[flag];
  }
  return Object.keys(recurrence).length ? recurrence : undefined;
}

async function main() {
  const [command, ...rest] = process.argv.slice(2);
  const { positional, options } = parseArgs(rest);
  const pretty = options.pretty === true;
  const print = (value) => console.log(JSON.stringify(value, null, pretty ? 2 : 0));

  if (command === "calendars") {
    const calendars = await getCalendars(true);
    print({
      calendars: calendars.map((calendar) => ({
        id: calendar.id,
        title: calendar.title,
        type: calendar.type,
        source: calendar.source,
      })),
    });
    return;
  }
  if (command === "events") {
    print(
      await listEvents({
        from: options.from,
        to: options.to,
        calendars: listOption(options.calendars, DEFAULT_EVENT_CALENDARS),
        search: options.search,
        availability: options.availability,
      }),
    );
    return;
  }
  if (command === "add-event") {
    print(
      await addEvent({
        calendar: options.calendar || "Business",
        title: options.title,
        start: options.start,
        end: options.end,
        allDay: options["all-day"] === true,
        location: options.location,
        notes: options.notes,
        url: options.url,
        availability: options.availability,
        alarms: options.alarms,
        travelTime: options["travel-time"],
        recurrence: recurrenceFromOptions(options),
      }),
    );
    return;
  }
  if (command === "update-event") {
    print(
      await updateEvent({
        id: positional[0] || options.id,
        occurrence: options.occurrence,
        span: options.span,
        calendar: options.calendar,
        title: options.title,
        start: options.start,
        end: options.end,
        allDay: options["all-day"],
        location: options.location,
        notes: options.notes,
        url: options.url,
        availability: options.availability,
        alarms: options.alarms,
        addAlarms: options["add-alarms"],
        travelTime: options["travel-time"],
        recurrence: recurrenceFromOptions(options),
      }),
    );
    return;
  }
  if (command === "delete-event") {
    print(await deleteEvent({ id: positional[0] || options.id, occurrence: options.occurrence, span: options.span }));
    return;
  }
  if (command === "reminders") {
    print(
      await listReminders({
        lists: listOption(options.lists, DEFAULT_REMINDER_LISTS),
        completed: options.completed === true || options.completed === "true",
        search: options.search,
      }),
    );
    return;
  }
  if (command === "add-reminder") {
    print(
      await addReminder({
        list: options.list || "Business",
        title: options.title,
        due: options.due,
        notes: options.notes,
        priority: options.priority,
      }),
    );
    return;
  }
  if (command === "update-reminder") {
    print(
      await updateReminder({
        id: positional[0] || options.id,
        title: options.title,
        due: options.due,
        notes: options.notes,
        priority: options.priority,
        completed: options.completed,
      }),
    );
    return;
  }
  if (command === "complete-reminder") {
    print(await completeReminder({ id: positional[0] || options.id }));
    return;
  }
  if (command === "delete-reminder") {
    print(await deleteReminder({ id: positional[0] || options.id }));
    return;
  }
  if (command === "contacts") {
    print(
      await listContacts({
        refresh: options.refresh === true,
        search: options.search,
        limit: Number(options.limit || 20),
      }),
    );
    return;
  }
  if (command === "add-contact") {
    print(
      await addContact({
        firstName: options["first-name"] || "",
        lastName: options["last-name"] || "",
        name: options.name,
        org: options.org,
        title: options.title,
        phone: options.phone,
        email: options.email,
        note: options.note || options.notes,
      }),
    );
    return;
  }
  if (command === "update-contact") {
    print(
      await updateContact({
        id: positional[0] || options.id,
        firstName: options["first-name"],
        lastName: options["last-name"],
        name: options.name,
        org: options.org,
        title: options.title,
        phone: options.phone,
        email: options.email,
        note: options.note || options.notes,
      }),
    );
    return;
  }
  if (command === "delete-contact") {
    print(await deleteContact({ id: positional[0] || options.id }));
    return;
  }

  throw new Error(
    "Usage: cal.mjs calendars | events | add-event | update-event | delete-event | " +
      "reminders | add-reminder | update-reminder | complete-reminder | delete-reminder | " +
      "contacts | add-contact | update-contact | delete-contact",
  );
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().catch((err) => {
    console.error(JSON.stringify({ ok: false, error: err.message }));
    process.exitCode = 1;
  });
}

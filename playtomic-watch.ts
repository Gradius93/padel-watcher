/**
 * Playtomic slot watcher
 * ----------------------
 * Checks padel availability at Playtomic clubs near SE3 and sends a push
 * notification (via ntfy.sh) when a slot that matches your preferences
 * appears that wasn't there on the previous run — new releases AND
 * cancellations.
 *
 * Usage:
 *   npx tsx playtomic-watch.ts           # normal run: diff + notify
 *   npx tsx playtomic-watch.ts --list    # print clubs + every matching slot now, no notify
 *
 * Env:
 *   NTFY_TOPIC   your private ntfy topic (if unset, notifications print to the console)
 *   STATE_FILE   where seen slots are stored (default .playtomic-state.json)
 *
 * Note: this uses Playtomic's undocumented app API (the same one the app/web
 * uses). It needs no login for search + availability, but it can change
 * without warning. Keep the polling interval polite (10–15 min).
 */
import { readFile, writeFile } from "node:fs/promises";

// ───────────────────────────── Config ─────────────────────────────

type Weekday = "Mon" | "Tue" | "Wed" | "Thu" | "Fri" | "Sat" | "Sun";
type Window = [from: string, to: string]; // slot START time must fall within (HH:MM, inclusive)

const CONFIG = {
  home: { lat: 51.4655, lon: 0.0118, label: "SE3" }, // Blackheath / Lee / Kidbrooke
  radiusKm: 8,
  daysAhead: 8, // today + next 7 days
  durations: [60, 90] as number[], // minutes you'd accept
  doublesOnly: true,
  indoorOnly: false,
  maxPrice: undefined as number | undefined, // per court, e.g. 60
  windows: {
    Mon: [["18:00", "21:00"]],
    Tue: [["18:00", "21:00"]],
    Wed: [["18:00", "21:00"]],
    Thu: [["18:00", "21:00"]],
    Fri: [["17:30", "20:30"]],
    Sat: [["08:00", "16:00"]],
    Sun: [["08:00", "16:00"]],
  } satisfies Record<Weekday, Window[]> as Record<Weekday, Window[]>,
  excludeTenantIds: [] as string[], // clubs you never want (ids shown by --list)
  maxPerNotification: 8,
  apiBase: process.env.PLAYTOMIC_API ?? "https://app.playtomic.io/api/v1",
  ntfyTopic: process.env.NTFY_TOPIC ?? "",
  stateFile: process.env.STATE_FILE ?? ".playtomic-state.json",
  concurrency: 4,
};

// ───────────────────────────── Types ──────────────────────────────

interface Resource {
  resource_id: string;
  name: string;
  sport_id?: string;
  properties?: { resource_type?: string; resource_size?: string };
}

interface Tenant {
  tenant_id: string;
  tenant_name: string;
  address?: {
    street?: string;
    city?: string;
    postal_code?: string;
    coordinate?: { lat: number; lon: number };
  };
  resources?: Resource[];
}

interface Availability {
  resource_id: string;
  start_date: string; // YYYY-MM-DD
  slots: { start_time: string; duration: number; price: string }[];
}

interface Club {
  id: string;
  name: string;
  distanceKm: number;
  postcode?: string;
  courts: Map<string, Resource>;
}

interface Slot {
  key: string;
  club: Club;
  court: string;
  indoor?: boolean;
  date: string;
  weekday: Weekday;
  start: string; // HH:MM
  duration: number;
  price: string;
}

// ──────────────────────────── Helpers ─────────────────────────────

const TZ = "Europe/London";
const args = new Set(process.argv.slice(2));
const LIST_MODE = args.has("--list");

async function getJson<T>(url: string, attempts = 3): Promise<T> {
  for (let i = 1; ; i++) {
    try {
      const res = await fetch(url, {
        headers: { Accept: "application/json", "User-Agent": "padel-slot-watcher/1.0" },
        signal: AbortSignal.timeout(15_000),
      });
      if (res.status === 429 || res.status >= 500) throw new Error(`HTTP ${res.status}`);
      if (!res.ok) throw Object.assign(new Error(`HTTP ${res.status} for ${url}`), { fatal: true });
      return (await res.json()) as T;
    } catch (err) {
      if ((err as { fatal?: boolean }).fatal || i >= attempts) throw err;
      await new Promise((r) => setTimeout(r, 1000 * 2 ** i));
    }
  }
}

function haversineKm(a: { lat: number; lon: number }, b: { lat: number; lon: number }) {
  const rad = (d: number) => (d * Math.PI) / 180;
  const dLat = rad(b.lat - a.lat);
  const dLon = rad(b.lon - a.lon);
  const h = Math.sin(dLat / 2) ** 2 + Math.cos(rad(a.lat)) * Math.cos(rad(b.lat)) * Math.sin(dLon / 2) ** 2;
  return 6371 * 2 * Math.asin(Math.sqrt(h));
}

function londonDays(n: number) {
  const ymd = new Intl.DateTimeFormat("en-CA", { timeZone: TZ });
  const wd = new Intl.DateTimeFormat("en-GB", { timeZone: TZ, weekday: "short" });
  return Array.from({ length: n }, (_, i) => {
    const d = new Date(Date.now() + i * 86_400_000);
    return { date: ymd.format(d), weekday: wd.format(d) as Weekday };
  });
}

function londonNowHHMM() {
  return new Intl.DateTimeFormat("en-GB", { timeZone: TZ, hour: "2-digit", minute: "2-digit", hour12: false }).format(new Date());
}

function prettyDate(date: string) {
  return new Intl.DateTimeFormat("en-GB", { weekday: "short", day: "numeric", month: "short", timeZone: "UTC" }).format(
    new Date(`${date}T12:00:00Z`),
  );
}

function formatPrice(price: string) {
  const [amount, currency] = price.split(" ");
  return currency === "GBP" ? `£${Number(amount).toFixed(0)}` : price;
}

async function pool<T, R>(items: T[], size: number, fn: (item: T) => Promise<R>): Promise<R[]> {
  const out: R[] = [];
  let next = 0;
  await Promise.all(
    Array.from({ length: Math.min(size, items.length) }, async () => {
      while (next < items.length) {
        const i = next++;
        out[i] = await fn(items[i]);
      }
    }),
  );
  return out;
}

// ─────────────────────────── Playtomic ────────────────────────────

async function findClubs(): Promise<Club[]> {
  const { lat, lon } = CONFIG.home;
  const url =
    `${CONFIG.apiBase}/tenants?sport_id=PADEL&coordinate=${lat},${lon}` +
    `&radius=${Math.round(CONFIG.radiusKm * 1000)}&size=50`;
  const tenants = await getJson<Tenant[]>(url);

  return tenants
    .filter((t) => t.address?.coordinate && !CONFIG.excludeTenantIds.includes(t.tenant_id))
    .map((t) => ({
      id: t.tenant_id,
      name: t.tenant_name.trim(),
      postcode: t.address?.postal_code,
      distanceKm: haversineKm(CONFIG.home, t.address!.coordinate!),
      courts: new Map((t.resources ?? []).filter((r) => !r.sport_id || r.sport_id === "PADEL").map((r) => [r.resource_id, r])),
    }))
    .filter((c) => c.distanceKm <= CONFIG.radiusKm && c.courts.size > 0)
    .sort((a, b) => a.distanceKm - b.distanceKm);
}

async function clubSlots(club: Club, day: { date: string; weekday: Weekday }): Promise<Slot[]> {
  const windows = CONFIG.windows[day.weekday];
  if (!windows.length) return [];

  const url =
    `${CONFIG.apiBase}/availability?sport_id=PADEL&tenant_id=${club.id}` +
    `&local_start_min=${day.date}T00:00:00&local_start_max=${day.date}T23:59:59`;

  let rows: Availability[];
  try {
    rows = await getJson<Availability[]>(url);
  } catch (err) {
    console.warn(`  ! ${club.name} ${day.date}: ${(err as Error).message}`);
    return [];
  }

  const isToday = day.date === londonDays(1)[0].date;
  const now = londonNowHHMM();
  const slots: Slot[] = [];

  for (const row of rows) {
    const court = club.courts.get(row.resource_id);
    const size = court?.properties?.resource_size;
    const type = court?.properties?.resource_type;
    if (CONFIG.doublesOnly && size && size !== "double") continue;
    if (CONFIG.indoorOnly && type && type !== "indoor") continue;

    for (const s of row.slots) {
      const start = s.start_time.slice(0, 5);
      if (!CONFIG.durations.includes(s.duration)) continue;
      if (isToday && start <= now) continue;
      if (!windows.some(([from, to]) => start >= from && start <= to)) continue;
      if (CONFIG.maxPrice !== undefined && parseFloat(s.price) > CONFIG.maxPrice) continue;

      slots.push({
        key: `${club.id}|${row.resource_id}|${row.start_date}|${start}|${s.duration}`,
        club,
        court: court?.name ?? "Court",
        indoor: type ? type === "indoor" : undefined,
        date: row.start_date,
        weekday: day.weekday,
        start,
        duration: s.duration,
        price: s.price,
      });
    }
  }
  return slots;
}

// ───────────────────────── State + notify ─────────────────────────

async function loadSeen(): Promise<Set<string> | null> {
  try {
    const json = JSON.parse(await readFile(CONFIG.stateFile, "utf8")) as { seen: string[] };
    return new Set(json.seen);
  } catch {
    return null; // first run
  }
}

async function saveSeen(keys: string[]) {
  await writeFile(CONFIG.stateFile, JSON.stringify({ updatedAt: new Date().toISOString(), seen: keys }, null, 2));
}

function line(s: Slot) {
  const where = s.indoor === undefined ? "" : s.indoor ? " (indoor)" : " (outdoor)";
  return `${prettyDate(s.date)} ${s.start} · ${s.duration}m · ${s.club.name} ${s.club.distanceKm.toFixed(1)}km · ${s.court}${where} · ${formatPrice(s.price)}`;
}

async function notify(slots: Slot[]) {
  const shown = slots.slice(0, CONFIG.maxPerNotification);
  const extra = slots.length - shown.length;
  const title = `${slots.length} new padel slot${slots.length === 1 ? "" : "s"} near ${CONFIG.home.label}`;
  const body = shown.map(line).join("\n") + (extra > 0 ? `\n+${extra} more` : "");

  if (!CONFIG.ntfyTopic) {
    console.log(`\n${title}\n${body}`);
    return;
  }

  const res = await fetch(`https://ntfy.sh/${CONFIG.ntfyTopic}`, {
    method: "POST",
    body,
    headers: {
      Title: title,
      Tags: "tennis",
      Priority: slots.some((s) => s.date === londonDays(1)[0].date) ? "high" : "default",
      Click: `https://app.playtomic.io/tenant/${shown[0].club.id}`,
    },
  });
  if (!res.ok) throw new Error(`ntfy failed: HTTP ${res.status}`);
}

// ───────────────────────────── Main ───────────────────────────────

async function main() {
  const clubs = await findClubs();
  if (!clubs.length) throw new Error("No Playtomic padel clubs found in range — try a bigger radiusKm.");

  if (LIST_MODE) {
    console.log(`Clubs within ${CONFIG.radiusKm}km of ${CONFIG.home.label}:`);
    for (const c of clubs) console.log(`  ${c.distanceKm.toFixed(1)}km  ${c.name}  [${c.courts.size} courts]  id=${c.id}`);
  }

  const days = londonDays(CONFIG.daysAhead);
  const jobs = clubs.flatMap((club) => days.map((day) => ({ club, day })));
  const all = (await pool(jobs, CONFIG.concurrency, ({ club, day }) => clubSlots(club, day))).flat();

  all.sort((a, b) => a.date.localeCompare(b.date) || a.start.localeCompare(b.start) || a.club.distanceKm - b.club.distanceKm);

  if (LIST_MODE) {
    console.log(`\n${all.length} matching slots right now:`);
    for (const s of all) console.log(`  ${line(s)}`);
    return;
  }

  const seen = await loadSeen();
  await saveSeen(all.map((s) => s.key)); // only keep what's live now, so cancellations re-trigger

  if (seen === null) {
    console.log(`First run: recorded ${all.length} existing slots as a baseline. You'll be notified about new ones from now on.`);
    return;
  }

  const fresh = all.filter((s) => !seen.has(s.key));
  console.log(`${clubs.length} clubs, ${all.length} matching slots, ${fresh.length} new.`);
  if (fresh.length) await notify(fresh);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
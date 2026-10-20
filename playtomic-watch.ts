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
 * Note: this uses playtomic.com's undocumented web endpoints (club pages +
 * /api/clubs/availability). They need no login but can change without
 * warning. Keep the polling interval polite (10–15 min).
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
  // Clubs are discovered by crawling "nearby clubs" links on playtomic.com club pages from these seeds
  seedClubs: ["catford-padel-collective", "padel-padel-eltham", "padel-social-club-the-o2", "padel-box-bermondsey"],
  crawlMarginKm: 4, // keep following links from clubs up to radiusKm + this
  maxClubPages: 80,
  clubCacheHours: 24,
  maxPerNotification: 8,
  site: process.env.PLAYTOMIC_SITE ?? "https://playtomic.com",
  ntfyTopic: process.env.NTFY_TOPIC ?? "",
  stateFile: process.env.STATE_FILE ?? ".playtomic-state.json",
  concurrency: 1,
  requestDelayMs: 750, // playtomic.com's CloudFront returns 403 for a while if hit too fast
};

// ───────────────────────────── Types ──────────────────────────────

interface Resource {
  resourceId: string;
  name: string;
  sport: string;
  features: string[]; // e.g. "indoor" | "outdoor", "double" | "single", "panoramic"
}

interface Availability {
  resource_id: string;
  start_date: string; // YYYY-MM-DD (UTC)
  slots: { start_time: string; duration: number; price: string }[]; // start_time is UTC
}

interface Club {
  id: string;
  slug: string;
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

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

async function getText(url: string, attempts = 3): Promise<string> {
  for (let i = 1; ; i++) {
    try {
      await sleep(CONFIG.requestDelayMs);
      const res = await fetch(url, {
        headers: { "User-Agent": "padel-slot-watcher/1.0" },
        signal: AbortSignal.timeout(15_000),
      });
      if (res.status === 429 || res.status >= 500) throw new Error(`HTTP ${res.status}`);
      if (!res.ok) throw Object.assign(new Error(`HTTP ${res.status} for ${url}`), { fatal: true, status: res.status });
      return await res.text();
    } catch (err) {
      if ((err as { fatal?: boolean }).fatal || i >= attempts) throw err;
      await sleep(1000 * 2 ** i);
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

async function getJson<T>(url: string): Promise<T> {
  return JSON.parse(await getText(url)) as T;
}

function londonDays(n: number) {
  const ymd = new Intl.DateTimeFormat("en-CA", { timeZone: TZ });
  const wd = new Intl.DateTimeFormat("en-GB", { timeZone: TZ, weekday: "short" });
  return Array.from({ length: n }, (_, i) => {
    const d = new Date(Date.now() + i * 86_400_000);
    return { date: ymd.format(d), weekday: wd.format(d) as Weekday };
  });
}

const londonYMD = new Intl.DateTimeFormat("en-CA", { timeZone: TZ });
const londonWeekday = new Intl.DateTimeFormat("en-GB", { timeZone: TZ, weekday: "short" });
const londonHHMM = new Intl.DateTimeFormat("en-GB", { timeZone: TZ, hour: "2-digit", minute: "2-digit", hour12: false });

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
        try {
          out[i] = await fn(items[i]);
        } catch (err) {
          next = items.length; // stop the other workers too
          throw err;
        }
      }
    }),
  );
  return out;
}

// ─────────────────────────── Playtomic ────────────────────────────

function unescape(s: string) {
  try {
    return JSON.parse(`"${s}"`) as string;
  } catch {
    return s;
  }
}

// Club pages embed the tenant (with coordinates + courts) in the Next.js payload as escaped JSON
function parseClubPage(html: string) {
  const text = html.replaceAll('\\"', '"');
  const t = /"tenant":\{"tenant_id":"([^"]+)","tenant_name":"([^"]+)","slug":"([^"]+)","address":\{(.*?)"coordinate":\{"lat":([-\d.]+),"lon":([-\d.]+)\}/.exec(text);
  if (!t) return null;
  const courts = new Map<string, Resource>();
  for (const m of text.matchAll(/\{"resourceId":"([^"]+)","name":"([^"]+)","sport":"([^"]+)","features":\[([^\]]*)\]/g)) {
    const features = [...m[4].matchAll(/"([^"]+)"/g)].map((f) => f[1]);
    if (m[3] === "PADEL") courts.set(m[1], { resourceId: m[1], name: unescape(m[2]), sport: m[3], features });
  }
  return {
    id: t[1],
    name: unescape(t[2]).trim(),
    slug: t[3],
    postcode: /"postal_code":"([^"]*)"/.exec(t[4])?.[1],
    coordinate: { lat: Number(t[5]), lon: Number(t[6]) },
    courts,
    neighbours: [...new Set([...html.matchAll(/href="\/clubs\/([a-z0-9-]+)"/g)].map((m) => m[1]))],
  };
}

async function crawlClubs(): Promise<Club[]> {
  const queue = [...CONFIG.seedClubs];
  const visited = new Set(queue);
  const clubs: Club[] = [];

  while (queue.length) {
    const batch = queue.splice(0, CONFIG.concurrency);
    const pages = await Promise.all(
      batch.map(async (slug) => {
        try {
          return parseClubPage(await getText(`${CONFIG.site}/clubs/${slug}`));
        } catch (err) {
          // A dead link is fine; anything else (e.g. a 403 block) would cache an incomplete club list
          if ((err as { status?: number }).status !== 404) throw err;
          return null;
        }
      }),
    );
    for (const p of pages) {
      if (!p) continue;
      const distanceKm = haversineKm(CONFIG.home, p.coordinate);
      if (distanceKm > CONFIG.radiusKm + CONFIG.crawlMarginKm) continue;
      if (distanceKm <= CONFIG.radiusKm && p.courts.size) {
        clubs.push({ id: p.id, slug: p.slug, name: p.name, postcode: p.postcode, distanceKm, courts: p.courts });
      }
      for (const n of p.neighbours) {
        if (visited.has(n) || visited.size >= CONFIG.maxClubPages) continue;
        visited.add(n);
        queue.push(n);
      }
    }
  }
  return clubs;
}

// Club discovery is slow-changing, so reuse the crawled list from state for clubCacheHours
async function findClubs(state: State | null): Promise<{ clubs: Club[]; clubsAt: string }> {
  const fresh = state?.clubs && Date.now() - Date.parse(state.clubsAt ?? "") < CONFIG.clubCacheHours * 3_600_000;
  const clubs = fresh
    ? state!.clubs!.map((c) => ({ ...c, courts: new Map(c.courts.map((r) => [r.resourceId, r])) }))
    : await crawlClubs();
  return {
    clubs: clubs.filter((c) => !CONFIG.excludeTenantIds.includes(c.id)).sort((a, b) => a.distanceKm - b.distanceKm),
    clubsAt: fresh ? state!.clubsAt! : new Date().toISOString(),
  };
}

async function clubSlots(club: Club, day: { date: string; weekday: Weekday }): Promise<Slot[]> {
  const url = `${CONFIG.site}/api/clubs/availability?tenant_id=${club.id}&date=${day.date}&sport_id=PADEL`;

  const rows = await getJson<Availability[]>(url);
  const today = londonDays(1)[0].date;
  const now = londonNowHHMM();
  const slots: Slot[] = [];

  for (const row of rows) {
    const court = club.courts.get(row.resource_id);
    const features = court?.features ?? [];
    if (CONFIG.doublesOnly && features.includes("single")) continue;
    if (CONFIG.indoorOnly && features.includes("outdoor")) continue;

    for (const s of row.slots) {
      // Availability times are UTC; convert to London local date/time
      const at = new Date(`${row.start_date}T${s.start_time}Z`);
      const date = londonYMD.format(at);
      const weekday = londonWeekday.format(at) as Weekday;
      const start = londonHHMM.format(at);
      if (!CONFIG.durations.includes(s.duration)) continue;
      if (date < today || (date === today && start <= now)) continue;
      if (!CONFIG.windows[weekday].some(([from, to]) => start >= from && start <= to)) continue;
      if (CONFIG.maxPrice !== undefined && parseFloat(s.price) > CONFIG.maxPrice) continue;

      slots.push({
        key: `${club.id}|${row.resource_id}|${date}|${start}|${s.duration}`,
        club,
        court: court?.name ?? "Court",
        indoor: features.includes("indoor") ? true : features.includes("outdoor") ? false : undefined,
        date,
        weekday,
        start,
        duration: s.duration,
        price: s.price,
      });
    }
  }
  return slots;
}

// ───────────────────────── State + notify ─────────────────────────

type StoredClub = Omit<Club, "courts"> & { courts: Resource[] };

interface State {
  seen: string[];
  clubs?: StoredClub[];
  clubsAt?: string;
}

async function loadState(): Promise<State | null> {
  try {
    return JSON.parse(await readFile(CONFIG.stateFile, "utf8")) as State;
  } catch {
    return null; // first run
  }
}

async function saveState(keys: string[], clubs: Club[], clubsAt: string) {
  const stored: StoredClub[] = clubs.map((c) => ({ ...c, courts: [...c.courts.values()] }));
  const state: State = { seen: keys, clubs: stored, clubsAt };
  await writeFile(CONFIG.stateFile, JSON.stringify({ updatedAt: new Date().toISOString(), ...state }, null, 2));
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
      Click: `${CONFIG.site}/clubs/${shown[0].club.slug}`,
    },
  });
  if (!res.ok) throw new Error(`ntfy failed: HTTP ${res.status}`);
}

// ───────────────────────────── Main ───────────────────────────────

async function main() {
  const state = await loadState();
  const { clubs, clubsAt } = await findClubs(state);
  if (!clubs.length) throw new Error("No Playtomic padel clubs found in range — try a bigger radiusKm.");

  if (LIST_MODE) {
    console.log(`Clubs within ${CONFIG.radiusKm}km of ${CONFIG.home.label}:`);
    for (const c of clubs) console.log(`  ${c.distanceKm.toFixed(1)}km  ${c.name}  [${c.courts.size} courts]  id=${c.id}`);
  }

  const days = londonDays(CONFIG.daysAhead);
  const jobs = clubs.flatMap((club) => days.map((day) => ({ club, day })));
  let found: Slot[];
  try {
    found = (await pool(jobs, CONFIG.concurrency, ({ club, day }) => clubSlots(club, day))).flat();
  } catch (err) {
    // Saving a partial result would make every missing slot look "new" on the next run
    console.warn(`Playtomic request failed, keeping previous state: ${(err as Error).message}`);
    return;
  }
  const all = [...new Map(found.map((s) => [s.key, s])).values()]; // UTC→local can put a slot under a neighbouring day's query

  all.sort((a, b) => a.date.localeCompare(b.date) || a.start.localeCompare(b.start) || a.club.distanceKm - b.club.distanceKm);

  if (LIST_MODE) {
    console.log(`\n${all.length} matching slots right now:`);
    for (const s of all) console.log(`  ${line(s)}`);
    return;
  }

  const seen = state ? new Set(state.seen) : null;
  // only keep what's live now, so cancellations re-trigger
  await saveState(all.map((s) => s.key), clubs, clubsAt);

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
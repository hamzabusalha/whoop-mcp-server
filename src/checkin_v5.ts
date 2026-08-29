import Database from 'better-sqlite3';
import { timingSafeEqual } from 'node:crypto';
import type { Express, Request, Response } from 'express';

// ---------------------------------------------------------------------------
// Hamza's daily check-in: a small survey page served by this server, storing
// entries in the same SQLite database as the Whoop data. No sign-in — access
// is a private key in the URL (CHECKIN_KEY env var). The morning brief reads
// the log through the get_checkins MCP tool.
// ---------------------------------------------------------------------------

const CHECKIN_KEY = process.env.CHECKIN_KEY ?? '';
const CHECKIN_DB_PATH = process.env.DB_PATH ?? './whoop.db';
const MAX_ENTRY_BYTES = 16000;

type CheckinEntry = Record<string, unknown> & { gym?: Record<string, unknown> };

let checkinDb: Database.Database | null = null;

function getDb(): Database.Database {
	if (!checkinDb) {
		checkinDb = new Database(CHECKIN_DB_PATH);
		checkinDb.pragma('journal_mode = WAL');
		checkinDb.exec(`
			CREATE TABLE IF NOT EXISTS checkins (
				date TEXT PRIMARY KEY,
				data TEXT NOT NULL,
				updated_at TEXT NOT NULL
			);

			CREATE TABLE IF NOT EXISTS brief (
				id INTEGER PRIMARY KEY CHECK (id = 1),
				html TEXT NOT NULL,
				label TEXT,
				updated_at TEXT NOT NULL
			);
		`);
	}
	return checkinDb;
}

function keyOk(req: Request): boolean {
	const given = String(req.query.key ?? '');
	if (!CHECKIN_KEY || !given) return false;
	const a = Buffer.from(given);
	const b = Buffer.from(CHECKIN_KEY);
	return a.length === b.length && timingSafeEqual(a, b);
}

function validDate(d: unknown): d is string {
	return typeof d === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(d);
}

function readEntries(days: number): Record<string, CheckinEntry> {
	const rows = getDb()
		.prepare('SELECT date, data FROM checkins ORDER BY date DESC LIMIT ?')
		.all(days) as Array<{ date: string; data: string }>;
	const entries: Record<string, CheckinEntry> = {};
	for (const row of rows) {
		try {
			entries[row.date] = JSON.parse(row.data) as CheckinEntry;
		} catch {
			// skip unparseable rows rather than failing the whole read
		}
	}
	return entries;
}

function readEntry(date: string): CheckinEntry | null {
	const row = getDb().prepare('SELECT data FROM checkins WHERE date = ?').get(date) as
		| { data: string }
		| undefined;
	if (!row) return null;
	try {
		return JSON.parse(row.data) as CheckinEntry;
	} catch {
		return null;
	}
}

function mergeEntry(prev: CheckinEntry | null, patch: CheckinEntry): CheckinEntry {
	const merged: CheckinEntry = { ...(prev ?? {}), ...patch };
	if (prev?.gym && patch.gym && typeof patch.gym === 'object') {
		merged.gym = { ...prev.gym, ...patch.gym };
	}
	return merged;
}

function writeEntry(date: string, entry: CheckinEntry): void {
	const data = JSON.stringify(entry);
	getDb()
		.prepare(
			`INSERT INTO checkins (date, data, updated_at) VALUES (?, ?, ?)
			 ON CONFLICT(date) DO UPDATE SET data = excluded.data, updated_at = excluded.updated_at`
		)
		.run(date, data, new Date().toISOString());
}

// ------------------------------ brief storage ------------------------------

const MAX_BRIEF_BYTES = 400_000;

function readBrief(): { html: string; label: string | null; updated_at: string } | null {
	const row = getDb().prepare('SELECT html, label, updated_at FROM brief WHERE id = 1').get() as
		| { html: string; label: string | null; updated_at: string }
		| undefined;
	return row ?? null;
}

function writeBrief(html: string, label: string | null): void {
	getDb()
		.prepare(
			`INSERT INTO brief (id, html, label, updated_at) VALUES (1, ?, ?, ?)
			 ON CONFLICT(id) DO UPDATE SET html = excluded.html, label = excluded.label, updated_at = excluded.updated_at`
		)
		.run(html, label, new Date().toISOString());
}

// ------------------------------ MCP tools ----------------------------------

export const checkinToolDefs = [
	{
		name: 'get_checkins',
		description:
			"Get Hamza's self-logged daily check-in entries (morning survey, after-training survey, plan changes, day notes) recorded on the server's check-in page. Returns JSON keyed by date (YYYY-MM-DD).",
		inputSchema: {
			type: 'object',
			properties: {
				days: { type: 'number', description: 'How many recent days to return (default: 60, max: 120)' },
			},
			required: [],
		},
	},
	{
		name: 'get_brief',
		description:
			"Get the performance-brief fragment currently shown at the top of Hamza's page, with its label and last-updated time. Use before publish_brief to see what the page currently says.",
		inputSchema: { type: 'object', properties: {}, required: [] },
	},
	{
		name: 'publish_brief',
		description:
			"Replace the performance-brief fragment shown at the top of Hamza's page (above the daily check-in form). Pass an HTML FRAGMENT only — no <html>/<head>/<body>, no <script>, and no check-in form (the server renders that below it). The page's stylesheet already defines: mast, eyebrow, pill, dot, verdict, lede, why, tiles, tile, val, unit, note, waiting, card, sub, num, unlock, urow, uwhen (now/soon/later), notebox, chips. A <style> block for additional components is allowed. Start the fragment with <header class=\"mast\"> containing the date. The page updates instantly for anyone who opens it.",
		inputSchema: {
			type: 'object',
			properties: {
				html: { type: 'string', description: 'The brief HTML fragment' },
				label: {
					type: 'string',
					description: 'Short label for this brief, e.g. "Friday 29 August · Day 3"',
				},
			},
			required: ['html'],
		},
	},
];

export function handleCheckinTool(
	name: string,
	args: Record<string, unknown>
): { content: Array<{ type: 'text'; text: string }> } {
	if (name === 'get_checkins') {
		const raw = Number(args?.days);
		const days = Number.isFinite(raw) && raw >= 1 ? Math.min(Math.floor(raw), 120) : 60;
		const entries = readEntries(days);
		const count = Object.keys(entries).length;
		const text =
			count === 0
				? 'No check-in entries logged yet.'
				: `Check-in log — last ${days} days, ${count} logged day(s):\n\n` +
				  JSON.stringify({ entries }, null, 1);
		return { content: [{ type: 'text' as const, text }] };
	}

	if (name === 'get_brief') {
		const brief = readBrief();
		const text = brief
			? `Current brief — label: ${brief.label ?? '(none)'} — updated: ${brief.updated_at}\n\n${brief.html}`
			: 'No brief published yet. The page shows its built-in placeholder.';
		return { content: [{ type: 'text' as const, text }] };
	}

	if (name === 'publish_brief') {
		const html = typeof args?.html === 'string' ? args.html : '';
		if (!html.trim()) {
			return { content: [{ type: 'text' as const, text: 'Error: html is required and was empty.' }] };
		}
		if (Buffer.byteLength(html, 'utf8') > MAX_BRIEF_BYTES) {
			return {
				content: [{ type: 'text' as const, text: `Error: brief too large (max ${MAX_BRIEF_BYTES} bytes).` }],
			};
		}
		if (/<\s*script\b/i.test(html)) {
			return {
				content: [{ type: 'text' as const, text: 'Error: <script> is not allowed in the brief fragment — the page has its own script.' }],
			};
		}
		const label = typeof args?.label === 'string' && args.label.trim() ? args.label.trim() : null;
		writeBrief(html, label);
		return {
			content: [{ type: 'text' as const, text: `Brief published (${label ?? 'no label'}). The page shows it immediately.` }],
		};
	}

	return { content: [{ type: 'text' as const, text: `Unknown check-in tool: ${name}` }] };
}

// ------------------------------ HTTP routes --------------------------------

export function registerCheckinRoutes(app: Express): void {
	app.get('/checkin', (req: Request, res: Response) => {
		if (!keyOk(req)) {
			res.status(403).send('Not available.');
			return;
		}
		res.setHeader('Content-Type', 'text/html; charset=utf-8');
		res.setHeader('Cache-Control', 'no-store');
		res.setHeader('X-Robots-Tag', 'noindex, nofollow');
		const brief = readBrief();
		const briefHtml = brief ? brief.html : DEFAULT_BRIEF;
		res.send(CHECKIN_PAGE.replace('<!--BRIEF-->', () => briefHtml));
	});

	app.get('/api/checkins', (req: Request, res: Response) => {
		if (!keyOk(req)) {
			res.status(403).json({ error: 'forbidden' });
			return;
		}
		const raw = Number(req.query.days);
		const days = Number.isFinite(raw) && raw >= 1 ? Math.min(Math.floor(raw), 120) : 60;
		res.json({ entries: readEntries(days) });
	});

	app.post('/api/checkin', (req: Request, res: Response) => {
		if (!keyOk(req)) {
			res.status(403).json({ error: 'forbidden' });
			return;
		}
		const body = (req.body ?? {}) as { date?: unknown; patch?: unknown; clear?: unknown };
		if (!validDate(body.date)) {
			res.status(400).json({ error: 'bad date' });
			return;
		}
		if (body.clear === true) {
			getDb().prepare('DELETE FROM checkins WHERE date = ?').run(body.date);
			res.json({ ok: true, entry: null });
			return;
		}
		if (typeof body.patch !== 'object' || body.patch === null || Array.isArray(body.patch)) {
			res.status(400).json({ error: 'bad patch' });
			return;
		}
		const merged = mergeEntry(readEntry(body.date), body.patch as CheckinEntry);
		if (JSON.stringify(merged).length > MAX_ENTRY_BYTES) {
			res.status(413).json({ error: 'entry too large' });
			return;
		}
		writeEntry(body.date, merged);
		res.json({ ok: true, entry: merged });
	});
}

// ------------------------------ the page -----------------------------------
// Always-dark, phone-first. All JS uses string concatenation (no template
// literals) so this file's template literal stays clean. The morning runs
// replace the brief section via the publish_brief MCP tool; the server
// injects it where <!--BRIEF--> sits. Until the first publish, a built-in
// placeholder masthead renders instead.

const DEFAULT_BRIEF = `<header class="mast">
  <div>
    <div class="eyebrow">Performance brief &middot; Hamza</div>
    <h1 id="hd-date">Today</h1>
  </div>
  <div class="pill"><span class="dot"></span>Live &middot; calibrating</div>
</header>
<section class="card">
  <p class="sub">The first brief lands here with the next morning rebuild (07:30, and 12:30 on
  Fri/Sat). Your logs below already count.</p>
</section>`;

const CHECKIN_PAGE = `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta name="robots" content="noindex, nofollow">
<title>Hamza — Daily Log</title>
<link rel="preconnect" href="https://fonts.googleapis.com">
<link rel="preconnect" href="https://fonts.gstatic.com" crossorigin>
<link rel="stylesheet" href="https://fonts.googleapis.com/css2?family=Archivo:wght@400;500;600;700&family=IBM+Plex+Mono:wght@400;500;600&family=Newsreader:ital,opsz,wght@0,6..72,300;0,6..72,400&display=swap">
<style>
:root{
  color-scheme: dark;
  --plane:#0B0D12; --surface:#15181F; --surface-2:#1B1F28;
  --ink:#F2F4F7; --ink-2:#A7AEBB; --muted:#7C8391;
  --rule:#242935; --rule-strong:#333A48;
  --teal:#23A3B2; --teal-ink:#4FC0CC; --teal-wash:rgba(35,163,178,.14);
  --good:#0CA30C; --good-wash:rgba(12,163,12,.13); --good-ink:#37C337;
  --warn:#FAB219; --warn-wash:rgba(250,178,25,.14); --warn-ink:#FAB219;
}
*{box-sizing:border-box}
body{margin:0;background:var(--plane);color:var(--ink);
  font-family:"Archivo","Helvetica Neue",Arial,sans-serif;font-size:15px;line-height:1.6;
  -webkit-font-smoothing:antialiased}
.wrap{max-width:820px;margin:0 auto;padding:28px 20px 80px;display:flex;flex-direction:column;gap:18px}
.eyebrow{font-family:"IBM Plex Mono",ui-monospace,monospace;font-size:10.5px;font-weight:500;
  letter-spacing:.13em;text-transform:uppercase;color:var(--muted)}
.card{background:var(--surface);border:1px solid var(--rule);border-radius:12px;padding:22px 24px}
h2{font-size:15.5px;font-weight:600;letter-spacing:-.006em;margin:0 0 6px}
p{margin:0}
.sub{color:var(--ink-2);font-size:13.5px}
.num{font-variant-numeric:tabular-nums}
.mast{display:flex;justify-content:space-between;align-items:flex-end;gap:16px;flex-wrap:wrap;
  padding-bottom:16px;border-bottom:1px solid var(--rule-strong)}
.mast h1{font-size:19px;font-weight:600;letter-spacing:-.01em;margin:4px 0 0}
.pill{display:inline-flex;align-items:center;gap:7px;padding:5px 11px 5px 9px;border-radius:999px;
  font-size:12.5px;font-weight:600;white-space:nowrap;background:var(--teal-wash);color:var(--teal-ink)}
.pill .dot{width:9px;height:9px;border-radius:50%;background:var(--teal);flex:none}
.pill.good{background:var(--good-wash);color:var(--good-ink)}
.pill.good .dot{background:var(--good)}
.pill.warn{background:var(--warn-wash);color:var(--warn-ink)}
.pill.warn .dot{background:var(--warn)}
.verdict{background:var(--teal-wash);border:1px solid rgba(35,163,178,.34);
  border-radius:12px;padding:24px 26px 22px}
.verdict .lede{font-family:"Newsreader",Georgia,serif;font-weight:300;font-size:27px;line-height:1.3;
  letter-spacing:-.011em;margin:8px 0 0;text-wrap:balance}
.verdict .lede em{font-style:italic}
.verdict .why{margin-top:15px;font-size:13.5px;line-height:1.62;color:var(--ink-2);max-width:62ch}
.tiles{display:grid;grid-template-columns:repeat(3,1fr);gap:14px}
@media (max-width:680px){.tiles{grid-template-columns:1fr}}
.tile{background:var(--surface);border:1px solid var(--rule);border-radius:12px;padding:16px 18px 16px;min-width:0}
.tile .val{font-family:"Newsreader",Georgia,serif;font-weight:400;font-size:44px;line-height:1.05;
  letter-spacing:-.02em;margin-top:8px;font-variant-numeric:tabular-nums}
.tile .unit{font-family:"IBM Plex Mono",monospace;font-size:13px;color:var(--muted);margin-left:3px}
.tile .note{font-family:"IBM Plex Mono",monospace;font-size:11.5px;color:var(--ink-2);margin-top:8px}
.waiting{border-style:dashed;background:transparent}
.waiting .val{color:var(--muted);font-size:34px;letter-spacing:0}
.unlock{display:flex;flex-direction:column}
.urow{display:grid;grid-template-columns:118px 1fr;gap:18px;padding:15px 0;border-top:1px solid var(--rule)}
.urow:first-of-type{border-top:none;padding-top:4px}
@media (max-width:560px){.urow{grid-template-columns:1fr;gap:4px}}
.uwhen{font-family:"IBM Plex Mono",monospace;font-size:11px;letter-spacing:.08em;text-transform:uppercase;
  padding-top:3px}
.uwhen.now{color:var(--good-ink);font-weight:600}
.uwhen.soon{color:var(--teal-ink);font-weight:600}
.uwhen.later{color:var(--muted)}
.urow h3{font-size:14px;font-weight:600;margin:0 0 3px;letter-spacing:-.004em}
.urow p{font-size:13px;color:var(--ink-2);max-width:62ch}
.notebox{border-radius:10px;padding:14px 16px;font-size:13px;line-height:1.6;margin-top:16px;
  background:var(--warn-wash);color:var(--ink-2)}
.notebox b{color:var(--warn-ink);font-weight:600}
.ci-tabs{display:flex;gap:6px;margin-top:14px;background:var(--surface-2);border:1px solid var(--rule);
  border-radius:10px;padding:4px;width:fit-content}
.ci-tabs button{font-family:"Archivo",sans-serif;font-size:13.5px;font-weight:600;padding:8px 16px;
  border:none;border-radius:7px;background:transparent;color:var(--muted);cursor:pointer}
.ci-tabs button.on{background:var(--teal-wash);color:var(--teal-ink)}
.ci-q{margin-top:16px}
.ci-q label{display:block;font-size:13.5px;font-weight:600;margin-bottom:8px;letter-spacing:-.003em}
.ci-q .opt{font-weight:400;color:var(--muted);font-size:12px}
.chips{display:flex;flex-wrap:wrap;gap:7px}
.chips button{font-family:"IBM Plex Mono",monospace;font-size:12.5px;padding:7px 12px;border-radius:999px;
  border:1px solid var(--rule-strong);background:var(--surface-2);color:var(--ink-2);cursor:pointer;min-width:38px}
.chips button.on{background:var(--teal-wash);border-color:var(--teal);color:var(--teal-ink);font-weight:600}
.ci-q input[type=text]{width:100%;padding:10px 12px;border-radius:8px;border:1px solid var(--rule-strong);
  background:var(--surface-2);color:var(--ink);font-family:"Archivo",sans-serif;font-size:14px}
.ci-btn{margin-top:20px;width:100%;padding:13px;border-radius:10px;border:none;background:var(--teal);
  color:#06181b;font-family:"Archivo",sans-serif;font-size:14.5px;font-weight:700;cursor:pointer;letter-spacing:.01em}
.ci-btn:disabled{opacity:.55;cursor:default}
.ci-msg{margin-top:10px;font-size:13px;color:var(--ink-2);min-height:18px}
.ci-status{margin-top:12px}
.ci-done{background:var(--good-wash);color:var(--good-ink);border-radius:10px;padding:12px 14px;
  font-size:13.5px;font-weight:600}
.ci-done span{font-weight:400;color:var(--ink-2);display:block;margin-top:2px;font-size:12.5px}
#ci-history{margin-top:18px}
#ci-history .hrow{display:flex;gap:10px;align-items:baseline;padding:7px 0;border-top:1px solid var(--rule);
  font-size:12.5px;color:var(--ink-2)}
#ci-history .hd{font-family:"IBM Plex Mono",monospace;font-size:11px;color:var(--muted);flex:none;width:86px}
#ci-history .eyebrow{margin-bottom:6px}
.ci-details{margin-top:18px;border:1px dashed var(--rule-strong);border-radius:10px;padding:12px 14px}
.ci-details summary{cursor:pointer;font-size:13.5px;font-weight:600;color:var(--ink-2);list-style:none}
.ci-details summary::-webkit-details-marker{display:none}
.ci-details summary::before{content:"+";display:inline-block;width:18px;color:var(--teal-ink);font-weight:700}
.ci-details[open] summary::before{content:"\\2212"}
.ci-details .opt{font-weight:400;color:var(--muted);font-size:12px}
#ci-todo{background:var(--warn-wash);border:1px solid rgba(250,178,25,.35);border-radius:12px;
  padding:14px 18px;display:flex;align-items:center;gap:14px;flex-wrap:wrap}
#ci-todo .t{font-size:13.5px;font-weight:600;color:var(--warn-ink);flex:none}
#ci-todo .items{display:flex;gap:8px;flex-wrap:wrap}
#ci-todo button{display:inline-flex;align-items:center;gap:8px;font-family:"Archivo",sans-serif;
  font-size:13px;font-weight:600;padding:8px 14px;border-radius:999px;cursor:pointer;
  border:1px solid rgba(250,178,25,.45);background:transparent;color:var(--ink)}
#ci-todo button::before{content:"";width:14px;height:14px;border-radius:50%;
  border:2px solid var(--warn);flex:none}
#ci-todo .done-note{font-size:12px;color:var(--muted)}
#ci-todo button.restbtn{border-style:dashed;border-color:var(--rule-strong);color:var(--ink-2);font-weight:500}
#ci-todo button.restbtn::before{display:none}
footer{border-top:1px solid var(--rule);padding-top:14px;color:var(--muted);font-size:12px;max-width:68ch}
footer b{color:var(--ink-2)}
:focus-visible{outline:2px solid var(--teal);outline-offset:2px;border-radius:4px}
</style>
</head>
<body>
<div class="wrap">

<!--BRIEF-->

<section class="card" id="checkin">
  <div class="eyebrow" style="margin-bottom:4px">Daily check-in &middot; Hamza</div>
  <h2 style="margin-bottom:2px">Two quick logs a day &mdash; the analysis runs on these</h2>
  <p class="sub" style="max-width:62ch">Morning one with breakfast, training one on the way out of
    the gym. Answers save straight to the server and feed the next morning's brief.</p>
  <div class="ci-tabs" role="tablist">
    <button type="button" class="on" data-tab="am">Morning</button>
    <button type="button" data-tab="gym">After training</button>
  </div>
  <div id="ci-status" class="ci-status"></div>

  <form id="ci-form" onsubmit="return false">
  <div class="ci-pane" data-pane="am">
    <div class="ci-q"><label>How sore are you overall right now?</label>
      <div class="chips" data-name="soreness" data-single>
        <button type="button" data-v="0">0</button><button type="button" data-v="1">1</button><button type="button" data-v="2">2</button><button type="button" data-v="3">3</button><button type="button" data-v="4">4</button><button type="button" data-v="5">5</button><button type="button" data-v="6">6</button><button type="button" data-v="7">7</button><button type="button" data-v="8">8</button><button type="button" data-v="9">9</button><button type="button" data-v="10">10</button>
      </div></div>
    <div class="ci-q"><label>Where? <span class="opt">tap all that apply</span></label>
      <div class="chips" data-name="soreWhere">
        <button type="button" data-v="quads">Quads</button><button type="button" data-v="hamstrings">Hamstrings</button><button type="button" data-v="lower-back">Lower back</button><button type="button" data-v="upper-back">Upper back</button><button type="button" data-v="chest">Chest</button><button type="button" data-v="shoulders">Shoulders</button><button type="button" data-v="arms">Arms</button><button type="button" data-v="back-stiff">Back feels stiff</button>
      </div></div>
    <div class="ci-q"><label>Energy this morning?</label>
      <div class="chips" data-name="energy" data-single>
        <button type="button" data-v="1">1</button><button type="button" data-v="2">2</button><button type="button" data-v="3">3</button><button type="button" data-v="4">4</button><button type="button" data-v="5">5</button><button type="button" data-v="6">6</button><button type="button" data-v="7">7</button><button type="button" data-v="8">8</button><button type="button" data-v="9">9</button><button type="button" data-v="10">10</button>
      </div></div>
    <div class="ci-q"><label>How stressed do you feel? <span class="opt">1 calm &mdash; 10 maxed out</span></label>
      <div class="chips" data-name="feltStress" data-single>
        <button type="button" data-v="1">1</button><button type="button" data-v="2">2</button><button type="button" data-v="3">3</button><button type="button" data-v="4">4</button><button type="button" data-v="5">5</button><button type="button" data-v="6">6</button><button type="button" data-v="7">7</button><button type="button" data-v="8">8</button><button type="button" data-v="9">9</button><button type="button" data-v="10">10</button>
      </div></div>
    <div class="ci-q"><label>Is today a school day?</label>
      <div class="chips" data-name="school" data-single>
        <button type="button" data-v="yes">Yes</button><button type="button" data-v="no">No / weekend</button><button type="button" data-v="holiday">Holiday / break</button>
      </div></div>
    <div class="ci-q"><label>School / life load today?</label>
      <div class="chips" data-name="stress" data-single>
        <button type="button" data-v="low">Light</button><button type="button" data-v="normal">Normal</button><button type="button" data-v="high">Heavy</button><button type="button" data-v="exams">Exams / deadline</button>
      </div></div>
    <div class="ci-q"><label>Yesterday &mdash; caffeine after 2pm?</label>
      <div class="chips" data-name="lateCaffeine" data-single>
        <button type="button" data-v="none">None</button><button type="button" data-v="14-16">2&ndash;4pm</button><button type="button" data-v="16-18">4&ndash;6pm</button><button type="button" data-v="18-20">6&ndash;8pm</button><button type="button" data-v="after-20">After 8pm</button>
      </div></div>
    <div class="ci-q"><label>Morning weight <span class="opt">optional &mdash; only if you weighed, kg</span></label>
      <input type="text" id="ci-weight" inputmode="decimal" placeholder="e.g. 80.4" maxlength="6"></div>
    <div class="ci-q"><label>Anything else? <span class="opt">optional &mdash; sick, slept badly, big meal late&hellip;</span></label>
      <input type="text" id="ci-note" placeholder="" maxlength="240"></div>
    <button class="ci-btn" type="button" data-save="am">Save morning log</button>
  </div>

  <div class="ci-pane" data-pane="gym" hidden>
    <div class="ci-q"><label>What did you train today?</label>
      <div class="chips" data-name="gymType" data-single>
        <button type="button" data-v="lower">Lower</button><button type="button" data-v="upper">Upper</button><button type="button" data-v="upper-arms">Upper &middot; arms</button><button type="button" data-v="full">Full body</button><button type="button" data-v="rpm">RPM / cardio</button><button type="button" data-v="other">Other</button><button type="button" data-v="rest">Didn't train</button>
      </div></div>
    <div class="ci-q gym-only"><label>When did you train?</label>
      <div class="chips" data-name="gymTime" data-single>
        <button type="button" data-v="morning">Morning</button><button type="button" data-v="after-school">Straight after school</button><button type="button" data-v="evening">Evening 5&ndash;8</button><button type="button" data-v="night">Night, after 8</button>
      </div></div>
    <div class="ci-q gym-only"><label>How long was the session?</label>
      <div class="chips" data-name="gymLength" data-single>
        <button type="button" data-v="under-60">Under 1h</button><button type="button" data-v="60-90">1&ndash;1.5h</button><button type="button" data-v="90-120">1.5&ndash;2h</button><button type="button" data-v="over-120">Over 2h</button>
      </div></div>
    <div class="ci-q gym-only"><label>How strong did you feel?</label>
      <div class="chips" data-name="gymFeel" data-single>
        <button type="button" data-v="weak">Weak day</button><button type="button" data-v="off">Slightly off</button><button type="button" data-v="normal">Normal</button><button type="button" data-v="good">Good</button><button type="button" data-v="strong">Unusually strong</button>
      </div></div>
    <div class="ci-q gym-only"><label>Pump / fullness?</label>
      <div class="chips" data-name="gymPump" data-single>
        <button type="button" data-v="flat">Flat</button><button type="button" data-v="normal">Normal</button><button type="button" data-v="great">Great pump</button>
      </div></div>
    <div class="ci-q gym-only"><label>Eating before training?</label>
      <div class="chips" data-name="preMeal" data-single>
        <button type="button" data-v="fasted">Basically nothing</button><button type="button" data-v="snack">Light snack</button><button type="button" data-v="meal">Full meal 1&ndash;2h before</button><button type="button" data-v="big-close">Big meal right before</button>
      </div></div>
    <div class="ci-q gym-only"><label>Eating overall today?</label>
      <div class="chips" data-name="eatingDay" data-single>
        <button type="button" data-v="low">Under-ate</button><button type="button" data-v="normal">Normal</button><button type="button" data-v="big">Big bulking day</button>
      </div></div>
    <div class="ci-q gym-only"><label>Pre-workout?</label>
      <div class="chips" data-name="preworkout" data-single>
        <button type="button" data-v="no">No</button><button type="button" data-v="yes">Yes</button>
      </div></div>
    <div class="ci-q gym-only"><label>Spoon of salt before training?</label>
      <div class="chips" data-name="preSalt" data-single>
        <button type="button" data-v="no">No</button><button type="button" data-v="yes">Yes</button>
      </div></div>
    <div class="ci-q gym-only"><label>Top set of the day <span class="opt">optional</span></label>
      <input type="text" id="ci-topset" placeholder="e.g. bench 107.5 x 5" maxlength="120"></div>
    <div class="ci-q gym-only"><label>Anything about the session? <span class="opt">optional</span></label>
      <input type="text" id="ci-gymnote" placeholder="e.g. squat bottom felt easier, gym was packed" maxlength="240"></div>
    <button class="ci-btn" type="button" data-save="gym">Save training log</button>
  </div>

  <details class="ci-details">
    <summary>Plan changed? <span class="opt">only open this when your week is different from normal</span></summary>
    <div class="ci-q"><label>What changed?</label>
      <div class="chips" data-name="scheduleChange">
        <button type="button" data-v="extra-session">Extra gym day</button>
        <button type="button" data-v="swapped-days">Swapped days around</button>
        <button type="button" data-v="unplanned-rest">Taking a rest day</button>
        <button type="button" data-v="missed">Missed a session</button>
        <button type="button" data-v="new-split">New split this week</button>
        <button type="button" data-v="travel">Travelling</button>
      </div></div>
    <div class="ci-q"><label>What's the plan now? <span class="opt">optional</span></label>
      <input type="text" id="ci-plannote" placeholder="" maxlength="200"></div>
    <button class="ci-btn" type="button" data-save="plan" style="margin-top:12px">Save plan change</button>
  </details>
  <details class="ci-details">
    <summary>How was the day? <span class="opt">optional &mdash; a night comment about anything unique</span></summary>
    <div class="ci-q"><label>Say anything about today <span class="opt">bad day, tiring, something happened, felt great, whatever's worth remembering</span></label>
      <input type="text" id="ci-daynote" placeholder="" maxlength="300"></div>
    <button class="ci-btn" type="button" data-save="night" style="margin-top:12px">Save day comment</button>
  </details>
  <p id="ci-msg" class="ci-msg"></p>
  </form>
  <div id="ci-history"></div>
</section>

<footer>
  <b>One page, live data.</b> The brief above rebuilds from Hamza's Whoop every morning at 07:30
  &mdash; and again at 12:30 on Fridays and Saturdays, since weekend sleep runs late. The check-in
  answers save to Hamza's own server over this private link (no account needed) and feed the next
  rebuild. General training and wellness reasoning, not medical advice.
</footer>
</div>

<script>
(function(){
  var $=function(s){return document.querySelector(s);};
  var KEY=new URLSearchParams(location.search).get("key")||"";
  var LOG={entries:{}};
  var today=new Date().toLocaleDateString("en-CA",{timeZone:"Asia/Amman"});
  var esc=function(t){return String(t).replace(/&/g,"&amp;").replace(/</g,"&lt;").replace(/>/g,"&gt;");};
  var state={soreWhere:[],scheduleChange:[]};

  var hd=$("#hd-date");
  if(hd)hd.textContent=new Date().toLocaleDateString("en-GB",
    {timeZone:"Asia/Amman",weekday:"long",day:"numeric",month:"long"});

  function showTab(name){
    document.querySelectorAll(".ci-tabs button").forEach(function(x){x.classList.toggle("on",x.dataset.tab===name);});
    document.querySelectorAll(".ci-pane").forEach(function(p){p.hidden=p.dataset.pane!==name;});
  }
  document.querySelectorAll(".ci-tabs button").forEach(function(t){t.addEventListener("click",function(){showTab(t.dataset.tab);});});

  function gymDayInfo(){
    var e=LOG.entries[today]||{};
    var dow=new Date().toLocaleDateString("en-US",{timeZone:"Asia/Amman",weekday:"short"});
    var SPLIT={Tue:"Lower day",Thu:"Upper day",Fri:"Lower day",Sat:"Upper \\u00b7 arms day"};
    var label=SPLIT[dow]||null;
    var sc={};[].concat(e.scheduleChange||[]).concat(state.scheduleChange||[]).forEach(function(v){sc[v]=1;});
    if(sc["extra-session"]||sc["swapped-days"]||sc["new-split"])label=label||"Training day";
    if(sc["unplanned-rest"])label=null;
    if(e.gym&&e.gym.savedAt)label=label||"Training day";
    return label;
  }
  function updateGymVisibility(){
    var label=gymDayInfo();
    var tab=document.querySelector('.ci-tabs button[data-tab="gym"]');
    if(tab){tab.style.display=label?"":"none";
      if(!label&&!document.querySelector('[data-pane="gym"]').hidden)showTab("am");}
  }

  function renderTodo(){
    var old=document.getElementById("ci-todo");if(old)old.remove();
    var e=LOG.entries[today]||{};
    var trainDay=gymDayInfo();
    var items=[];
    if(!e.savedAt)items.push({label:"Morning log",tab:"am"});
    if(trainDay&&!(e.gym&&e.gym.savedAt))items.push({label:"After training \\u00b7 "+trainDay,tab:"gym"});
    if(!items.length)return;
    var div=document.createElement("div");div.id="ci-todo";
    div.innerHTML='<span class="t">Still to log today</span><span class="items"></span>'+
      '<span class="done-note">tap one \\u2014 it disappears once saved</span>';
    var wrap=div.querySelector(".items");
    items.forEach(function(it){
      var b=document.createElement("button");b.type="button";b.textContent=it.label;
      b.addEventListener("click",function(){showTab(it.tab);
        document.getElementById("checkin").scrollIntoView({behavior:"smooth",block:"start"});});
      wrap.appendChild(b);
    });
    if(trainDay&&!(e.gym&&e.gym.savedAt)){
      var rb=document.createElement("button");rb.type="button";rb.className="restbtn";
      rb.textContent="Not training today";
      rb.addEventListener("click",function(){
        rb.disabled=true;rb.textContent="Saving\\u2026";
        postPatch({scheduleChange:["unplanned-rest"]}).then(function(){
          if(msg)msg.textContent="Rest day logged \\u2014 no training log needed today.";
          refresh();
        }).catch(function(){
          rb.disabled=false;rb.textContent="Not training today";
          if(msg)msg.textContent="Couldn't save \\u2014 check your internet and try again.";
        });
      });
      wrap.appendChild(rb);
    }
    var mast=document.querySelector(".mast");
    if(mast&&mast.parentNode)mast.parentNode.insertBefore(div,mast.nextSibling);
    else document.body.prepend(div);
  }

  document.querySelectorAll(".chips").forEach(function(g){
    var name=g.dataset.name,single=g.hasAttribute("data-single");
    g.addEventListener("click",function(e){
      var b=e.target.closest("button");if(!b)return;
      if(single){g.querySelectorAll("button").forEach(function(x){x.classList.remove("on");});
        b.classList.add("on");state[name]=b.dataset.v;
        if(name==="gymType"){var rest=b.dataset.v==="rest";
          document.querySelectorAll(".gym-only").forEach(function(q){q.style.display=rest?"none":"";});}}
      else{b.classList.toggle("on");
        state[name]=[].map.call(g.querySelectorAll("button.on"),function(x){return x.dataset.v;});
        if(name==="scheduleChange"){updateGymVisibility();renderTodo();}}
    });
  });

  var GYMLBL={lower:"lower",upper:"upper","upper-arms":"arms",full:"full body",rpm:"RPM",other:"other",rest:"rest"};
  function renderStatus(){
    var st=$("#ci-status"),e=LOG.entries[today]||{};
    var bits=[];
    if(e.savedAt)bits.push("Morning logged \\u2713");
    if(e.gym&&e.gym.savedAt)bits.push("Training logged \\u2713");
    if(e.dayNote)bits.push("Day comment \\u2713");
    var sc=[].concat(e.scheduleChange||[]);
    if(sc.indexOf("unplanned-rest")>=0)bits.push("Rest day \\u2713");
    else if(sc.length)bits.push("Plan change \\u2713");
    st.innerHTML=bits.length?'<div class="ci-done">'+bits.join(" &nbsp;&middot;&nbsp; ")+
      '<span>Saving again replaces that part.</span></div>':"";
    var days=Object.keys(LOG.entries).sort().reverse();
    var h=$("#ci-history");
    if(days.length){
      h.innerHTML='<div class="eyebrow">Logged: '+days.length+' day'+(days.length>1?'s':'')+'</div>'+
        days.slice(0,7).map(function(d){var x=LOG.entries[d];var g=x.gym||{};
          return '<div class="hrow"><span class="hd">'+d.slice(5)+'</span><span>'+
          [x.soreness!==undefined?'sore '+x.soreness:null,
           x.energy!==undefined?'energy '+x.energy:null,
           x.feltStress!==undefined?'stress '+x.feltStress:null,
           g.gymType?esc(GYMLBL[g.gymType]||g.gymType)+(g.gymFeel?' ('+esc(g.gymFeel)+')':''):null,
           g.topSet?esc(g.topSet):null,
           g.preSalt==="yes"?'salt':null,
           x.weightKg?x.weightKg+'kg':null,
           x.lateCaffeine&&x.lateCaffeine!=="none"?'caffeine '+esc(x.lateCaffeine):null,
           x.scheduleChange?'plan: '+esc([].concat(x.scheduleChange).join(", ")):null,
           x.note?esc(x.note):null,
           g.gymNote?esc(g.gymNote):null,
           x.dayNote?'"'+esc(x.dayNote)+'"':null].filter(Boolean).join(' \\u00b7 ')+
          '</span></div>';}).join("");
    } else h.innerHTML="";
  }

  var msg=$("#ci-msg");
  var now=function(){return new Date().toLocaleTimeString("en-GB",{timeZone:"Asia/Amman",hour:"2-digit",minute:"2-digit"});};
  function clean(o){Object.keys(o).forEach(function(k){if(o[k]===undefined)delete o[k];});return o;}

  function buildAM(){
    return clean({
      soreness:state.soreness!==undefined?+state.soreness:undefined,
      soreWhere:state.soreWhere.length?state.soreWhere:undefined,
      energy:state.energy!==undefined?+state.energy:undefined,
      feltStress:state.feltStress!==undefined?+state.feltStress:undefined,
      school:state.school,stress:state.stress,lateCaffeine:state.lateCaffeine,
      weightKg:(function(){var w=parseFloat(($("#ci-weight").value||"").replace(",","."));
        return (w>=30&&w<=200)?w:undefined;})(),
      note:$("#ci-note").value.trim()||undefined,
      savedAt:now()});
  }
  function buildGym(){
    return clean({gym:clean({
      gymType:state.gymType,gymTime:state.gymTime,gymLength:state.gymLength,
      gymFeel:state.gymFeel,gymPump:state.gymPump,preMeal:state.preMeal,
      eatingDay:state.eatingDay,preworkout:state.preworkout,preSalt:state.preSalt,
      topSet:$("#ci-topset").value.trim()||undefined,
      gymNote:$("#ci-gymnote").value.trim()||undefined,
      savedAt:now()})});
  }
  function buildPlan(explicit){
    return clean({
      scheduleChange:(state.scheduleChange.length||explicit)?state.scheduleChange:undefined,
      scheduleNote:$("#ci-plannote").value.trim()||undefined});
  }
  function buildNight(){
    var v=$("#ci-daynote").value.trim();
    return v?{dayNote:v,dayNoteAt:now()}:{};
  }

  function refresh(){renderStatus();renderTodo();updateGymVisibility();}

  function postPatch(patch){
    return fetch("/api/checkin?key="+encodeURIComponent(KEY),{
      method:"POST",headers:{"Content-Type":"application/json"},
      body:JSON.stringify({date:today,patch:patch})
    }).then(function(r){if(!r.ok)throw new Error("save "+r.status);return r.json();})
      .then(function(j){if(j&&j.entry)LOG.entries[today]=j.entry;return j;});
  }

  function hydratePlan(){
    var e=LOG.entries[today]||{};
    var sc=[].concat(e.scheduleChange||[]);
    if(sc.length){
      state.scheduleChange=sc.slice();
      var g=document.querySelector('.chips[data-name="scheduleChange"]');
      if(g)sc.forEach(function(v){var b=g.querySelector('button[data-v="'+v+'"]');if(b)b.classList.add("on");});
      var det=document.querySelectorAll(".ci-details")[0];if(det)det.open=true;
    }
    var pn=$("#ci-plannote");
    if(e.scheduleNote&&pn&&!pn.value)pn.value=e.scheduleNote;
  }

  function load(){
    fetch("/api/checkins?days=30&key="+encodeURIComponent(KEY),{cache:"no-store"})
      .then(function(r){if(!r.ok)throw new Error("load "+r.status);return r.json();})
      .then(function(j){LOG.entries=(j&&j.entries)||{};hydratePlan();refresh();})
      .catch(function(){msg.textContent="Couldn't load earlier logs \\u2014 saving still works.";refresh();});
  }
  load();

  document.querySelectorAll("[data-save]").forEach(function(btn){btn.addEventListener("click",function(){
    var which=btn.dataset.save;
    var part=which==="am"?buildAM():which==="gym"?buildGym():which==="plan"?{}:buildNight();
    var plan=buildPlan(which==="plan");
    var savedSC=[].concat((LOG.entries[today]||{}).scheduleChange||[]).length;
    var meaningful=which==="am"?Object.keys(part).length>1
      :which==="gym"?Object.keys(part.gym||{}).length>1
      :which==="plan"?(state.scheduleChange.length>0||!!$("#ci-plannote").value.trim()||savedSC>0)
      :Object.keys(part).length>0;
    if(!meaningful&&!Object.keys(plan).length){msg.textContent="Tap at least one answer first.";return;}
    var patch=Object.assign({},part,plan);
    btn.disabled=true;msg.textContent="Saving\\u2026";
    fetch("/api/checkin?key="+encodeURIComponent(KEY),{
      method:"POST",
      headers:{"Content-Type":"application/json"},
      body:JSON.stringify({date:today,patch:patch})
    }).then(function(r){
      if(!r.ok)throw new Error("save "+r.status);
      return r.json();
    }).then(function(j){
      if(j&&j.entry)LOG.entries[today]=j.entry;
      btn.disabled=false;msg.textContent="Saved \\u2713 "+now();
      refresh();
    }).catch(function(err){
      btn.disabled=false;
      msg.textContent="Couldn't save ("+(err&&err.message?err.message:"error")+") \\u2014 check internet and try again.";
    });
  });});
})();
</script>
</body>
</html>
`;

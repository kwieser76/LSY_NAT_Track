#!/usr/bin/env node
// ---------------------------------------------------------------------------
// capture-nat.js
// Saves the North Atlantic track message as the FAA NOTAM system publishes it
// (https://nms.aim.faa.gov/datanat/nat.json) into an archive folder, so the weekly briefing can draw
// the tracks of every day of a week. The FAA page only ever shows the current sets: the eastbound
// (Gander, CZQX) set appears around 13:20Z for the coming night, the westbound (Shanwick, EGGX) set
// around 20:40Z for the next day. Run twice a day (05:30Z and 17:00Z) and every set is seen twice.
//
// Runs in the GitHub repository kwieser76/LSY_NAT_Track (workflow .github/workflows/nat-capture.yml,
// Node 20, no dependencies). The master copy lives in the briefing project, scripts/capture-nat.js;
// tools/nat-archive/README.md says how to install it.
//
//   node scripts/capture-nat.js                 writes <repo>/archive/...
//   NAT_ARCHIVE_DIR=/some/dir node scripts/capture-nat.js
//
// Layout:
//   archive/YYYY/MM/DD-HHMM.json   one capture: { capturedAt, source, signature, parts: [FAA records] }
//   archive/YYYY/MM/index.json     [{ file, capturedAt, sets: [{ icao, notam, from, to, parts, lastUpdated }] }]
//   archive/state.json             { signature, file, checkedAt } of the last capture written
// A capture is written only when its content changed: the signature is the sorted list of
// NOTAM number + part + last_updated of all records. A transient error (network, HTTP 5xx, bad
// JSON) is reported as a GitHub warning and the job still ends with exit 0, so one bad hour never
// turns the workflow red; a missing day shows up in the briefing as a missing day.
//
// The FAA data is a US Government work (public domain). The request carries a generic User-Agent
// and nothing about the person running it.
// ---------------------------------------------------------------------------
'use strict';

const fs = require('fs');
const path = require('path');

const URL = 'https://nms.aim.faa.gov/datanat/nat.json';
const UA = 'LSY-Briefing-NAT-archive/1.0';
const ROOT = process.env.NAT_ARCHIVE_DIR ? path.resolve(process.env.NAT_ARCHIVE_DIR) : path.resolve(__dirname, '..', 'archive');

// ---- pure helpers (tested offline in the briefing project) -----------------------------------
// The records that make up the track sets; anything else in the answer is ignored.
const isTrackRecord = r => r && typeof r === 'object' && /NAT_TRACK/.test(String(r.transaction_type || '')) && r.condition_message;
function signatureOf(records) {
  return (records || []).filter(isTrackRecord)
    .map(r => [r.notam_number_formatted || (r.icao_id + '@' + r.start_datetime), r.part_no, r.last_updated].join('|'))
    .sort().join(';');
}
// One entry per published set (Gander eastbound, Shanwick westbound): validity, parts, newest update.
function setsOf(records) {
  const by = {};
  (records || []).filter(isTrackRecord).forEach(r => {
    const k = String(r.icao_id) + '|' + r.start_datetime;
    const s = by[k] || (by[k] = { icao: String(r.icao_id), notam: r.notam_number_formatted || null, from: r.start_datetime || null, to: r.end_datetime || null, parts: 0, lastUpdated: '' });
    s.parts++;
    if (String(r.last_updated || '') > s.lastUpdated) s.lastUpdated = String(r.last_updated || '');
  });
  return Object.values(by).sort((a, b) => String(a.from).localeCompare(String(b.from)) || a.icao.localeCompare(b.icao));
}
// Where a capture taken at `iso` is filed.
function capturePaths(iso) {
  const y = iso.slice(0, 4), m = iso.slice(5, 7), d = iso.slice(8, 10), hm = iso.slice(11, 13) + iso.slice(14, 16);
  return { dir: y + '/' + m, file: d + '-' + hm + '.json', rel: y + '/' + m + '/' + d + '-' + hm + '.json' };
}
// What to do with one answer, given the last state: write (and with what), or skip and why.
function plan(records, state, iso) {
  const list = (records || []).filter(isTrackRecord);
  if (!list.length) return { write: false, reason: 'no track records in the answer' };
  const signature = signatureOf(list);
  if (state && state.signature === signature) return { write: false, reason: 'unchanged since ' + (state.file || 'the last capture') };
  const p = capturePaths(iso);
  return { write: true, signature, paths: p, sets: setsOf(list),
           capture: { capturedAt: iso, source: URL, signature, parts: list } };
}

// ---- I/O ---------------------------------------------------------------------------------------
const warn = msg => console.log('::warning title=NAT capture::' + msg);
const readJson = (p, dflt) => { try { return JSON.parse(fs.readFileSync(p, 'utf8')); } catch (e) { return dflt; } };
function writeJson(p, obj) {
  fs.mkdirSync(path.dirname(p), { recursive: true });
  const tmp = p + '.tmp-' + process.pid;
  fs.writeFileSync(tmp, JSON.stringify(obj, null, 1) + '\n');
  fs.renameSync(tmp, p);
}

async function fetchNat() {
  let last = null;
  for (let attempt = 0; attempt < 3; attempt++) {
    if (attempt) await new Promise(r => setTimeout(r, 5000 * attempt));
    const ac = new AbortController(), t = setTimeout(() => ac.abort(), 30000);
    try {
      const res = await fetch(URL, { signal: ac.signal, headers: { 'User-Agent': UA, Accept: 'application/json' } });
      if (!res.ok) { last = 'HTTP ' + res.status; if (res.status >= 400 && res.status < 500 && res.status !== 429) break; continue; }
      const j = JSON.parse(await res.text());
      if (!Array.isArray(j)) throw new Error('answer is not a list');
      return j;
    } catch (e) { last = e && e.name === 'AbortError' ? 'timeout after 30 s' : String((e && e.message) || e); }
    finally { clearTimeout(t); }
  }
  throw new Error(last || 'unknown error');
}

async function main() {
  const iso = new Date().toISOString();
  let records;
  try { records = await fetchNat(); }
  catch (e) { warn('nat.json not read (' + e.message + ') — nothing written; the next run will try again.'); return; }
  const statePath = path.join(ROOT, 'state.json');
  const state = readJson(statePath, null);
  const p = plan(records, state, iso);
  if (!p.write) { console.log('capture-nat: ' + p.reason + ' — nothing written.'); return; }
  writeJson(path.join(ROOT, p.paths.rel), p.capture);
  const idxPath = path.join(ROOT, p.paths.dir, 'index.json');
  const idx = readJson(idxPath, []);
  idx.push({ file: p.paths.file, capturedAt: iso, sets: p.sets });
  writeJson(idxPath, idx);
  writeJson(statePath, { signature: p.signature, file: p.paths.rel, checkedAt: iso });
  console.log('capture-nat: wrote archive/' + p.paths.rel + ' — ' + p.sets.map(s => s.icao + ' ' + String(s.from).slice(0, 16) + 'Z (' + s.parts + ' parts, updated ' + s.lastUpdated + ')').join(', '));
}

module.exports = { URL, UA, isTrackRecord, signatureOf, setsOf, capturePaths, plan };
if (require.main === module) main().catch(e => { warn('unexpected error: ' + ((e && e.message) || e)); process.exitCode = 0; });

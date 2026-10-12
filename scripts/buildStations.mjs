/**
 * buildStations.mjs
 *
 * Builds public/stations.json (every subway station complex with a location and
 * the routes that serve it) and public/stops.json (stop id -> name, for
 * "toward X" labels) from MTA's static GTFS feed.
 *
 * Usage:
 *   node scripts/buildStations.mjs [gtfsDir]
 *
 * If gtfsDir is omitted, gtfs_subway.zip is downloaded and unzipped to a temp dir.
 * Parent stations linked by transfers.txt (and within 400m) are merged into one
 * complex, e.g. Times Sq, so "nearby stations" doesn't list it four times.
 */

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import readline from 'node:readline';
import { execFileSync } from 'node:child_process';

const ZIP_URL = 'https://rrgtfsfeeds.s3.amazonaws.com/gtfs_subway.zip';
const OUT = new URL('../public/stations.json', import.meta.url);
const OUT_NAMES = new URL('../public/stops.json', import.meta.url);

async function getDir() {
  if (process.argv[2]) return process.argv[2];
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'gtfs-'));
  const res = await fetch(ZIP_URL);
  if (!res.ok) throw new Error('HTTP ' + res.status);
  const zip = path.join(dir, 'g.zip');
  fs.writeFileSync(zip, Buffer.from(await res.arrayBuffer()));
  execFileSync('unzip', ['-oq', zip, '-d', dir]);
  return dir;
}

function parseCsvLine(line) {
  const out = []; let cur = ''; let q = false;
  for (const ch of line) {
    if (ch === '"') q = !q;
    else if (ch === ',' && !q) { out.push(cur); cur = ''; }
    else cur += ch;
  }
  out.push(cur);
  return out;
}

async function eachRow(file, fn) {
  const rl = readline.createInterface({ input: fs.createReadStream(file) });
  let head = null;
  for await (const line of rl) {
    if (!line) continue;
    const cols = parseCsvLine(line.replace(/\r$/, ''));
    if (!head) { head = cols; continue; }
    const row = {};
    head.forEach((h, i) => { row[h] = cols[i]; });
    fn(row);
  }
}

function meters(a, b) {
  const R = 6371000, rad = Math.PI / 180;
  const dLat = (b.lat - a.lat) * rad, dLon = (b.lon - a.lon) * rad;
  const h = Math.sin(dLat / 2) ** 2 +
    Math.cos(a.lat * rad) * Math.cos(b.lat * rad) * Math.sin(dLon / 2) ** 2;
  return 2 * R * Math.asin(Math.sqrt(h));
}

const dir = await getDir();

// parent stations
const parents = {};
await eachRow(path.join(dir, 'stops.txt'), r => {
  if (r.location_type === '1') {
    parents[r.stop_id] = { id: r.stop_id, name: r.stop_name, lat: +r.stop_lat, lon: +r.stop_lon, routes: new Set() };
  }
});

// routes per parent station
const tripRoute = {};
await eachRow(path.join(dir, 'trips.txt'), r => { tripRoute[r.trip_id] = r.route_id; });
const seen = new Set();
await eachRow(path.join(dir, 'stop_times.txt'), r => {
  const parent = r.stop_id.slice(0, -1);
  const route = tripRoute[r.trip_id];
  if (!parents[parent] || !route) return;
  const k = parent + '|' + route;
  if (seen.has(k)) return;
  seen.add(k);
  parents[parent].routes.add(route);
});

// merge complexes (union-find over transfers between nearby parents)
const root = {};
Object.keys(parents).forEach(id => { root[id] = id; });
const find = id => (root[id] === id ? id : (root[id] = find(root[id])));
await eachRow(path.join(dir, 'transfers.txt'), r => {
  const a = parents[r.from_stop_id], b = parents[r.to_stop_id];
  if (!a || !b || a === b) return;
  if (meters(a, b) <= 400) root[find(a.id)] = find(b.id);
});

const groups = {};
Object.values(parents).forEach(p => { (groups[find(p.id)] = groups[find(p.id)] || []).push(p); });

const stations = Object.values(groups).map(members => {
  const routes = new Set();
  members.forEach(m => m.routes.forEach(r => routes.add(r)));
  const lead = members.slice().sort((a, b) => b.routes.size - a.routes.size)[0];
  const lat = members.reduce((s, m) => s + m.lat, 0) / members.length;
  const lon = members.reduce((s, m) => s + m.lon, 0) / members.length;
  return {
    id: lead.id,
    name: lead.name,
    lat: +lat.toFixed(5),
    lon: +lon.toFixed(5),
    routes: [...routes].sort(),
    stops: members.map(m => m.id).sort(),
  };
}).filter(s => s.routes.length).sort((a, b) => a.name.localeCompare(b.name));

fs.writeFileSync(OUT, JSON.stringify(stations));

// parent stop id -> name, used to label where a train is headed (its last stop)
const names = {};
Object.values(parents).forEach(p => { names[p.id] = p.name; });
fs.writeFileSync(OUT_NAMES, JSON.stringify(names));
console.log('wrote', stations.length, 'stations to', OUT.pathname);

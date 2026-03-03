/**
 * listStops.mjs
 *
 * Fetches a live MTA GTFS-realtime feed, decodes it with protobufjs,
 * and prints every stop_id seen in the feed. Use this to verify or discover
 * the stop IDs you need for stations.ts.
 *
 * Usage:
 *   node scripts/listStops.mjs [feed]
 *
 * Where [feed] is one of: ace (default), nqrw, 1234567, bdfm, g, jz, l, si
 *
 * Example — find stops for the C/E line:
 *   node scripts/listStops.mjs ace
 *
 * Example — find stops for the N/R/W line:
 *   node scripts/listStops.mjs nqrw
 */

import protobuf from 'protobufjs';

const FEED_SUFFIX = process.argv[2] ?? 'ace';
const BASE = 'https://api-endpoint.mta.info/Dataservice/mtagtfsfeeds/nyct%2Fgtfs';
const URL = FEED_SUFFIX === '1234567' ? BASE : `${BASE}-${FEED_SUFFIX}`;

// Minimal proto descriptor — just enough to decode stop_id fields
const descriptor = {
  nested: {
    transit_realtime: {
      nested: {
        FeedMessage: {
          fields: {
            header: { rule: 'required', type: 'FeedHeader', id: 1 },
            entity: { rule: 'repeated', type: 'FeedEntity', id: 2 },
          },
        },
        FeedHeader: {
          fields: {
            gtfsRealtimeVersion: { rule: 'required', type: 'string', id: 1 },
          },
        },
        FeedEntity: {
          fields: {
            id: { rule: 'required', type: 'string', id: 1 },
            tripUpdate: { type: 'TripUpdate', id: 3 },
          },
        },
        TripUpdate: {
          fields: {
            trip: { rule: 'required', type: 'TripDescriptor', id: 1 },
            stopTimeUpdate: {
              rule: 'repeated',
              type: 'StopTimeUpdate',
              id: 2,
            },
          },
        },
        TripDescriptor: {
          fields: {
            routeId: { type: 'string', id: 5 },
          },
        },
        StopTimeUpdate: {
          fields: {
            stopId: { type: 'string', id: 4 },
            arrival: { type: 'StopTimeEvent', id: 2 },
          },
        },
        StopTimeEvent: {
          fields: {
            time: { type: 'int64', id: 2 },
          },
        },
      },
    },
  },
};

async function main() {
  console.log(`Fetching: ${URL}\n`);

  const res = await fetch(URL);
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  const buf = new Uint8Array(await res.arrayBuffer());

  const root = protobuf.Root.fromJSON(descriptor);
  const FeedMessage = root.lookupType('transit_realtime.FeedMessage');
  const feed = FeedMessage.toObject(FeedMessage.decode(buf), { longs: Number });

  // Collect unique stop IDs grouped by route
  const byRoute = {};
  const now = Date.now() / 1000;

  for (const entity of feed.entity ?? []) {
    const tu = entity.tripUpdate;
    if (!tu) continue;
    const route = tu.trip?.routeId ?? '?';
    if (!byRoute[route]) byRoute[route] = new Set();
    for (const stu of tu.stopTimeUpdate ?? []) {
      if (stu.stopId && stu.arrival?.time > now) {
        byRoute[route].add(stu.stopId);
      }
    }
  }

  for (const [route, stops] of Object.entries(byRoute).sort()) {
    const sorted = [...stops].sort();
    console.log(`Route ${route}:`);
    for (const s of sorted) {
      console.log(`  ${s}`);
    }
  }
}

main().catch(e => { console.error(e); process.exit(1); });

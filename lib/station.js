'use strict';

// Arrivals for any one station complex, looked up by id from public/stations.json.
// Shared by api/station.js (Vercel) and server/server.js (local).

var fs       = require('fs');
var path     = require('path');
var protobuf = require('protobufjs');

var MAX_ARRIVAL_MINS = 40;
var FEED_TTL_MS      = 15000;
var BASE = 'https://api-endpoint.mta.info/Dataservice/mtagtfsfeeds/nyct%2Fgtfs';

var STATIONS = JSON.parse(
  fs.readFileSync(path.join(__dirname, '../public/stations.json'), 'utf8')
);
var BY_ID = {};
STATIONS.forEach(function(s) { BY_ID[s.id] = s; });

// route id -> feed url suffix ('' = the 1-7 / S feed)
var ROUTE_FEED = {
  A: '-ace', C: '-ace', E: '-ace', H: '-ace', FS: '-ace',
  B: '-bdfm', D: '-bdfm', F: '-bdfm', M: '-bdfm',
  G: '-g', J: '-jz', Z: '-jz', L: '-l', SI: '-si',
  N: '-nqrw', Q: '-nqrw', R: '-nqrw', W: '-nqrw'
};

function feedFor(route) {
  return BASE + (ROUTE_FEED[route] || '');
}

var DESCRIPTOR = {
  nested: { transit_realtime: { nested: {
    FeedMessage: { fields: {
      header: { rule: 'required', type: 'FeedHeader', id: 1 },
      entity: { rule: 'repeated', type: 'FeedEntity', id: 2 }
    } },
    FeedHeader: { fields: { gtfsRealtimeVersion: { rule: 'required', type: 'string', id: 1 } } },
    FeedEntity: { fields: {
      id:         { rule: 'required', type: 'string', id: 1 },
      tripUpdate: { type: 'TripUpdate', id: 3 }
    } },
    TripUpdate: {
      fields: {
        trip:           { rule: 'required', type: 'TripDescriptor', id: 1 },
        stopTimeUpdate: { rule: 'repeated', type: 'TripUpdate.StopTimeUpdate', id: 2 }
      },
      nested: {
        StopTimeEvent:  { fields: { time: { type: 'int64', id: 2 } } },
        StopTimeUpdate: { fields: {
          stopId:    { type: 'string', id: 4 },
          arrival:   { type: 'TripUpdate.StopTimeEvent', id: 2 },
          departure: { type: 'TripUpdate.StopTimeEvent', id: 3 }
        } }
      }
    },
    TripDescriptor: { fields: {
      routeId:            { type: 'string', id: 5 },
      nyctTripDescriptor: { type: 'NyctTripDescriptor', id: 1001 }
    } },
    NyctTripDescriptor: {
      fields: {
        isAssigned: { type: 'bool', id: 2 },
        direction:  { type: 'NyctTripDescriptor.Direction', id: 3 }
      },
      nested: { Direction: { values: { NORTH: 1, EAST: 2, SOUTH: 3, WEST: 4 } } }
    }
  } } }
};

var FeedMessage = protobuf.Root.fromJSON(DESCRIPTOR).lookupType('transit_realtime.FeedMessage');

// url -> { at, promise } so concurrent phones share one upstream fetch
var feedCache = {};

function loadFeed(url) {
  var hit = feedCache[url];
  if (hit && Date.now() - hit.at < FEED_TTL_MS) return hit.promise;

  var promise = fetch(url)
    .then(function(res) {
      if (!res.ok) throw new Error('HTTP ' + res.status + ' from ' + url);
      return res.arrayBuffer();
    })
    .then(function(buf) {
      return FeedMessage.toObject(FeedMessage.decode(new Uint8Array(buf)), { longs: Number });
    });

  feedCache[url] = { at: Date.now(), promise: promise };
  promise.catch(function() { delete feedCache[url]; });
  return promise;
}

function arrivalsFromFeed(feed, stopSet, nowTs) {
  var out = [];
  (feed.entity || []).forEach(function(entity) {
    var tu = entity.tripUpdate;
    if (!tu) return;

    var nyct = tu.trip && tu.trip.nyctTripDescriptor;
    if (nyct && nyct.isAssigned === false) return;

    var routeId = (tu.trip && tu.trip.routeId) || '';
    var nyctDir = nyct ? nyct.direction : null;

    (tu.stopTimeUpdate || []).forEach(function(stu) {
      var stopId = stu.stopId || '';
      if (!stopSet[stopId.slice(0, -1)]) return;

      var ts = (stu.arrival && stu.arrival.time) || (stu.departure && stu.departure.time) || 0;
      if (!ts) return;
      var secs = ts - nowTs;
      if (secs < 0 || secs > MAX_ARRIVAL_MINS * 60) return;

      var dir;
      if      (nyctDir === 1) dir = 'N';
      else if (nyctDir === 3) dir = 'S';
      else dir = stopId.slice(-1).toUpperCase() === 'N' ? 'N' : 'S';

      out.push({ line: routeId, dir: dir, ts: ts });
    });
  });
  return out;
}

function stationArrivals(id) {
  var st = BY_ID[id];
  if (!st) return Promise.resolve(null);

  var stopSet = {};
  st.stops.forEach(function(s) { stopSet[s] = true; });

  var urls = {};
  st.routes.forEach(function(r) { urls[feedFor(r)] = true; });

  var nowTs = Date.now() / 1000;
  var errors = 0;
  var jobs = Object.keys(urls).map(function(url) {
    return loadFeed(url)
      .then(function(feed) { return arrivalsFromFeed(feed, stopSet, nowTs); })
      .catch(function(err) {
        errors++;
        console.error('[feed error]', err.message);
        return [];
      });
  });

  return Promise.all(jobs).then(function(results) {
    var all = [].concat.apply([], results);
    all.sort(function(a, b) { return a.ts - b.ts; });
    return { station: st.id, arrivals: all, feedErrors: errors, fetchedAt: Date.now() };
  });
}

module.exports = { stationArrivals: stationArrivals, feedFor: feedFor, BY_ID: BY_ID };

'use strict';

var protobuf = require('protobufjs');

var MAX_ARRIVAL_MINS = 40;
var BASE = 'https://api-endpoint.mta.info/Dataservice/mtagtfsfeeds/nyct%2Fgtfs';

var STATION_FEEDS = [
  { key: '50th', feedUrl: BASE + '-ace',  stopIds: ['A28N', 'A28S'] },
  { key: '49th', feedUrl: BASE + '-nqrw', stopIds: ['R15N', 'R15S'] },
  { key: '42nd', feedUrl: BASE + '-ace',  stopIds: ['A27N', 'A27S'] },
  { key: '42nd', feedUrl: BASE + '-nqrw', stopIds: ['R16N', 'R16S'] },
  { key: '42nd', feedUrl: BASE,           stopIds: ['127N', '127S'] },
];

var FEED_GROUPS = (function() {
  var groups = {};
  STATION_FEEDS.forEach(function(sf) {
    if (!groups[sf.feedUrl]) groups[sf.feedUrl] = [];
    groups[sf.feedUrl].push(sf);
  });
  return groups;
}());

var DESCRIPTOR = {
  nested: {
    transit_realtime: {
      nested: {
        FeedMessage: {
          fields: {
            header: { rule: 'required', type: 'FeedHeader', id: 1 },
            entity: { rule: 'repeated', type: 'FeedEntity',  id: 2 },
          },
        },
        FeedHeader: {
          fields: { gtfsRealtimeVersion: { rule: 'required', type: 'string', id: 1 } },
        },
        FeedEntity: {
          fields: {
            id:         { rule: 'required', type: 'string',     id: 1 },
            tripUpdate: { type: 'TripUpdate', id: 3 },
          },
        },
        TripUpdate: {
          fields: {
            trip:           { rule: 'required', type: 'TripDescriptor',           id: 1 },
            stopTimeUpdate: { rule: 'repeated', type: 'TripUpdate.StopTimeUpdate', id: 2 },
          },
          nested: {
            StopTimeEvent: {
              fields: { time: { type: 'int64', id: 2 } },
            },
            StopTimeUpdate: {
              fields: {
                stopId:    { type: 'string',                    id: 4 },
                arrival:   { type: 'TripUpdate.StopTimeEvent',  id: 2 },
                departure: { type: 'TripUpdate.StopTimeEvent',  id: 3 },
              },
            },
          },
        },
        TripDescriptor: {
          fields: {
            routeId:            { type: 'string',             id: 5    },
            nyctTripDescriptor: { type: 'NyctTripDescriptor', id: 1001 },
          },
        },
        NyctTripDescriptor: {
          fields: {
            isAssigned: { type: 'bool', id: 2 },
            direction:  { type: 'NyctTripDescriptor.Direction', id: 3 },
          },
          nested: {
            Direction: { values: { NORTH: 1, EAST: 2, SOUTH: 3, WEST: 4 } },
          },
        },
      },
    },
  },
};

var FeedMessage = protobuf.Root.fromJSON(DESCRIPTOR)
  .lookupType('transit_realtime.FeedMessage');

function fetchArrivals() {
  var nowTs    = Date.now() / 1000;
  var feedUrls = Object.keys(FEED_GROUPS);

  var promises = feedUrls.map(function(feedUrl) {
    var stationFeeds = FEED_GROUPS[feedUrl];

    var stopToStation = {};
    stationFeeds.forEach(function(sf) {
      sf.stopIds.forEach(function(id) { stopToStation[id] = sf.key; });
    });

    return fetch(feedUrl)
      .then(function(res) {
        if (!res.ok) throw new Error('HTTP ' + res.status + ' from ' + feedUrl);
        return res.arrayBuffer();
      })
      .then(function(buf) {
        var msg  = FeedMessage.decode(new Uint8Array(buf));
        var feed = FeedMessage.toObject(msg, { longs: Number });
        var out  = [];

        (feed.entity || []).forEach(function(entity) {
          var tu = entity.tripUpdate;
          if (!tu) return;

          var nyct = tu.trip && tu.trip.nyctTripDescriptor;
          if (nyct && nyct.isAssigned === false) return;

          var routeId = (tu.trip && tu.trip.routeId) || '';
          var nyctDir = nyct ? nyct.direction : null;

          (tu.stopTimeUpdate || []).forEach(function(stu) {
            var stationKey = stopToStation[stu.stopId];
            if (!stationKey) return;

            var ts = (stu.arrival   && stu.arrival.time)   ||
                     (stu.departure && stu.departure.time) || 0;
            if (!ts) return;

            var secsAway = ts - nowTs;
            if (secsAway < 0 || secsAway > MAX_ARRIVAL_MINS * 60) return;

            var dir;
            if      (nyctDir === 1) dir = 'N';
            else if (nyctDir === 3) dir = 'S';
            else dir = (stu.stopId.slice(-1).toUpperCase() === 'N') ? 'N' : 'S';

            out.push({ line: routeId, dir: dir, ts: ts, station: stationKey });
          });
        });
        return out;
      })
      .catch(function(err) {
        console.error('[feed error]', err.message);
        return [];
      });
  });

  return Promise.all(promises).then(function(results) {
    var all = [];
    results.forEach(function(r) { all = all.concat(r); });
    all.sort(function(a, b) { return a.ts - b.ts; });
    return all;
  });
}

module.exports = function handler(req, res) {
  fetchArrivals()
    .then(function(arrivals) {
      res.setHeader('Cache-Control', 'no-store');
      res.json({ arrivals: arrivals, fetchedAt: Date.now() });
    })
    .catch(function(err) {
      res.status(500).json({ error: err.message });
    });
};

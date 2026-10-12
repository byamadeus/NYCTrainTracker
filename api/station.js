'use strict';

var lib = require('../lib/station');

module.exports = function handler(req, res) {
  var id = String((req.query && req.query.id) || '');
  lib.stationArrivals(id)
    .then(function(data) {
      if (!data) return res.status(404).json({ error: 'unknown station' });
      res.setHeader('Cache-Control', 'no-store');
      res.json(data);
    })
    .catch(function(err) {
      res.status(500).json({ error: err.message });
    });
};

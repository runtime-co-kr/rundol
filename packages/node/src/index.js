'use strict';

const http = require('http');
const VERSION = require('../package.json').version;

function createServer() {
  return http.createServer((request, response) => {
    if (request.url === '/health') {
      response.writeHead(200, { 'content-type': 'application/json; charset=utf-8' });
      response.end(JSON.stringify({ service: 'rundol-node', version: VERSION, status: 'ok' }));
      return;
    }
    response.writeHead(404).end('Not found');
  });
}

module.exports = { VERSION, createServer };

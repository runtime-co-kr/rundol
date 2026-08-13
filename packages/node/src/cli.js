'use strict';

const { VERSION, createServer } = require('./index');

function main(argv) {
  if (argv.includes('--version') || argv.includes('-v')) {
    process.stdout.write(`${VERSION}\n`);
    return;
  }
  const portIndex = argv.indexOf('--port');
  const port = portIndex >= 0 ? Number.parseInt(argv[portIndex + 1], 10) : 7331;
  if (!Number.isInteger(port) || port < 0 || port > 65535) throw new Error('--port는 0부터 65535 사이의 정수여야 합니다.');
  const server = createServer();
  server.listen(port, '127.0.0.1', () => process.stdout.write(`Rundol node: http://127.0.0.1:${server.address().port}\n`));
}

module.exports = { main };

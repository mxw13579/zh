import { createServer } from 'node:http';

import { loadConfig } from './adapter/config.js';
import { handleRequest } from './adapter/handler.js';

const config = loadConfig();

const server = createServer((request, response) => {
  void handleRequest(request, response, config);
});

server.listen(config.port, () => {
  process.stdout.write(`[adapter] listening on :${config.port}, upstream=${config.upstreamBaseUrl}\n`);
});

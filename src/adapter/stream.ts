import type { ServerResponse } from 'node:http';
import { Readable } from 'node:stream';

export function pipeBodyToResponse(
  body: ReadableStream<Uint8Array>,
  response: ServerResponse,
): Promise<void> {
  return new Promise((resolve, reject) => {
    const stream = Readable.fromWeb(body as unknown as ReadableStream);

    const done = (): void => {
      response.off('close', done);
      response.off('finish', done);
      resolve();
    };

    stream.on('error', reject);
    response.on('close', done);
    response.on('finish', done);
    stream.pipe(response);
  });
}


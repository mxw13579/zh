export function splitEvents(source: string, flush: boolean): { events: string[]; rest: string } {
  const normalized = source.includes('\r') ? source.replace(/\r\n/g, '\n') : source;
  const events: string[] = [];

  let start = 0;
  while (true) {
    const boundary = normalized.indexOf('\n\n', start);
    if (boundary === -1) {
      break;
    }

    const block = normalized.slice(start, boundary);
    if (block) {
      events.push(block);
    }
    start = boundary + 2;
  }

  const rest = normalized.slice(start);
  if (flush) {
    if (rest) {
      events.push(rest);
    }
    return { events, rest: '' };
  }

  return { events, rest };
}


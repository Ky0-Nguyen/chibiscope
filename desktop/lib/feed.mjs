// Minimal Server-Sent Events client for the main process. Works the same
// whether this app owns the server or another ChibiScope (CLI, editor) does.

import http from 'node:http';

export function subscribe(port, { onSnapshot, onEvent, onClear, onDown }) {
  let req = null;
  let closed = false;
  let retry = 1000;

  const connect = () => {
    if (closed) return;
    let buf = '';
    req = http.get({ host: '127.0.0.1', port, path: '/events', headers: { accept: 'text/event-stream' } }, (res) => {
      if (res.statusCode !== 200) { res.resume(); return fail(); }
      retry = 1000;
      res.setEncoding('utf8');
      res.on('data', (chunk) => {
        buf += chunk;
        let i;
        while ((i = buf.indexOf('\n\n')) !== -1) {
          const frame = buf.slice(0, i);
          buf = buf.slice(i + 2);
          let event = 'message';
          const data = [];
          for (const line of frame.split('\n')) {
            if (line.startsWith('event:')) event = line.slice(6).trim();
            else if (line.startsWith('data:')) data.push(line.slice(5).replace(/^ /, ''));
          }
          if (!data.length) continue;
          let payload;
          try { payload = JSON.parse(data.join('\n')); } catch { continue; }
          if (event === 'snapshot') onSnapshot?.(payload);
          else if (event === 'clear') onClear?.();
          else onEvent?.(payload);
        }
      });
      res.on('end', fail);
      res.on('error', fail);
    });
    req.on('error', fail);
  };

  let failing = false;
  function fail() {
    if (closed || failing) return;
    failing = true;
    req?.destroy();
    onDown?.();
    setTimeout(() => { failing = false; connect(); }, retry);
    retry = Math.min(retry * 2, 10000);
  }

  connect();
  return { close() { closed = true; req?.destroy(); } };
}

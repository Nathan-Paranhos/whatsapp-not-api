class RealtimeHub {
  constructor() {
    this.clients = new Set();
    this.heartbeat = setInterval(() => this.broadcast('heartbeat', { at: Date.now() }), 25_000);
    this.heartbeat.unref();
  }

  connect(req, res) {
    res.writeHead(200, {
      'Content-Type': 'text/event-stream; charset=utf-8',
      'Cache-Control': 'no-cache, no-transform',
      Connection: 'keep-alive',
      'X-Accel-Buffering': 'no',
    });
    res.write('retry: 2500\n\n');
    this.clients.add(res);
    this.send(res, 'connected', { at: Date.now() });

    req.on('close', () => this.clients.delete(res));
  }

  notify(reason = 'data') {
    this.broadcast('refresh', { reason, at: Date.now() });
  }

  broadcast(event, payload) {
    for (const client of this.clients) this.send(client, event, payload);
  }

  send(client, event, payload) {
    try {
      client.write(`event: ${event}\n`);
      client.write(`data: ${JSON.stringify(payload)}\n\n`);
    } catch {
      this.clients.delete(client);
    }
  }

  close() {
    clearInterval(this.heartbeat);
    for (const client of this.clients) client.end();
    this.clients.clear();
  }
}

module.exports = { RealtimeHub };


// Small JSON files on disk, one per kind of record, written atomically (write a temp file, then rename).
// The gateway keeps little of its own: who is who, reminders, phone alert subscriptions and developer agents.
// Chats themselves live in the chat server.
import fs from 'node:fs';
import path from 'node:path';

export function store(dir) {
  const cache = new Map();
  const file = (name) => path.join(dir, name + '.json');
  function read(name) {
    if (!cache.has(name)) { let v = {}; try { v = JSON.parse(fs.readFileSync(file(name), 'utf8')); } catch {} cache.set(name, v); }
    return cache.get(name);
  }
  function save(name) {
    const tmp = file(name) + '.' + process.pid + '.tmp';
    fs.writeFileSync(tmp, JSON.stringify(read(name)), { mode: 0o600 });
    fs.renameSync(tmp, file(name));
  }
  return {
    get: (name, id) => read(name)[id] ?? null,
    all: (name) => Object.values(read(name)),
    put(name, id, v) { read(name)[id] = v; save(name); return v; },
    del(name, id) { delete read(name)[id]; save(name); },
  };
}

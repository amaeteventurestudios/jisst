// The extras that run beside the gateway: the local model's answers reach the helper agent, and translation is off until set up.
import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { askLocal } from '../lib/bots.mjs';
import jisst from '../../app/agents/jisst.js';

test('the helper answers open questions from the local model, and keeps its menu without one', async () => {
  let asked = null;
  const srv = http.createServer((req, res) => { let b = ''; req.on('data', (c) => (b += c)); req.on('end', () => { asked = JSON.parse(b); res.end(JSON.stringify({ choices: [{ message: { content: '<think>\n</think>\nLagos is in Nigeria.' } }] })); }); }).listen(0);
  const url = `http://127.0.0.1:${srv.address().port}`;
  const a = await jisst.reply('where is lagos', { ask: (q) => askLocal(url, jisst, q) });
  assert.equal(a.text, 'Lagos is in Nigeria.');
  assert.match(asked.messages[1].content, /where is lagos \/no_think/);
  const b = await jisst.reply('where is lagos', {});
  assert.match(b.text, /didn't catch/);
  srv.close();
});

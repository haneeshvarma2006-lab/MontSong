/**
 * A stand-in Telegram Bot API server for the end-to-end test.
 *
 * It speaks the parts of the protocol this application uses — sendAudio,
 * sendDocument, sendPhoto, getFile, deleteMessage, and the file download
 * endpoint with Range support — backed by an in-memory store.
 *
 * The end-to-end test points TELEGRAM_API_BASE_URL at this, which means it
 * also exercises the self-hosted Bot API server configuration path.
 *
 * Usage: node tests/e2e/fake-bot-api.mjs [port]
 */
import http from 'node:http';
import { randomUUID } from 'node:crypto';

const files = new Map();
let messageId = 5000;
let counter = 0;

function json(res, payload, status = 200) {
  const body = JSON.stringify(payload);
  res.writeHead(status, { 'content-type': 'application/json', 'content-length': Buffer.byteLength(body) });
  res.end(body);
}

function parseMultipart(buffer, contentType) {
  const boundary = /boundary=(?:"([^"]+)"|([^;]+))/.exec(contentType)?.[1] ?? /boundary=([^;]+)/.exec(contentType)?.[1];
  const marker = Buffer.from(`--${boundary.trim()}`);
  const parts = [];
  let index = buffer.indexOf(marker);
  while (index !== -1) {
    const next = buffer.indexOf(marker, index + marker.length);
    if (next === -1) break;
    const chunk = buffer.subarray(index + marker.length + 2, next - 2);
    const headerEnd = chunk.indexOf('\r\n\r\n');
    if (headerEnd !== -1) {
      const headers = chunk.subarray(0, headerEnd).toString('utf8');
      const content = chunk.subarray(headerEnd + 4);
      const name = /name="([^"]+)"/.exec(headers)?.[1];
      const filename = /filename="([^"]*)"/.exec(headers)?.[1];
      const type = /Content-Type:\s*([^\r\n]+)/i.exec(headers)?.[1];
      parts.push({ name, filename, type, content });
    }
    index = next;
  }
  return parts;
}

const server = http.createServer((req, res) => {
  const chunks = [];
  req.on('data', (c) => chunks.push(c));
  req.on('end', () => {
    const buffer = Buffer.concat(chunks);
    const url = req.url ?? '';

    const download = /^\/file\/bot[^/]+\/(.+)$/.exec(url);
    if (download) {
      const wanted = decodeURIComponent(download[1]);
      const file = [...files.values()].find((f) => f.filePath === wanted);
      if (!file) { res.writeHead(404); res.end('nope'); return; }
      const range = req.headers.range;
      if (range) {
        const m = /bytes=(\d*)-(\d*)/.exec(range);
        const start = Number(m[1] || 0);
        const end = m[2] ? Number(m[2]) : file.bytes.length - 1;
        const slice = file.bytes.subarray(start, end + 1);
        res.writeHead(206, {
          'content-type': file.mime,
          'content-length': slice.length,
          'content-range': `bytes ${start}-${end}/${file.bytes.length}`,
        });
        res.end(slice);
        return;
      }
      res.writeHead(200, { 'content-type': file.mime, 'content-length': file.bytes.length });
      res.end(file.bytes);
      return;
    }

    const method = /^\/bot[^/]+\/([A-Za-z]+)/.exec(url)?.[1];
    if (!method) return json(res, { ok: false, description: 'Not Found' }, 404);

    if (method === 'getMe') {
      return json(res, { ok: true, result: { id: 7, is_bot: true, first_name: 'Smoke Bot', username: 'smoke_bot' } });
    }
    if (method === 'getChat') {
      return json(res, { ok: true, result: { id: -1001111111111, type: 'channel', title: 'Smoke Storage' } });
    }
    if (method === 'deleteMessage') {
      return json(res, { ok: true, result: true });
    }

    const parts = parseMultipart(buffer, req.headers['content-type'] ?? '');

    if (method === 'getFile') {
      const fileId = parts.find((p) => p.name === 'file_id')?.content.toString('utf8');
      const file = files.get(fileId);
      if (!file) return json(res, { ok: false, error_code: 400, description: 'Bad Request: file not found' }, 400);
      return json(res, { ok: true, result: { file_id: fileId, file_unique_id: file.uniqueId, file_size: file.bytes.length, file_path: file.filePath } });
    }

    if (method === 'sendAudio' || method === 'sendDocument' || method === 'sendPhoto') {
      const field = method === 'sendAudio' ? 'audio' : method === 'sendPhoto' ? 'photo' : 'document';
      const part = parts.find((p) => p.name === field);
      if (!part) return json(res, { ok: false, error_code: 400, description: 'Bad Request: no media' }, 400);

      counter += 1;
      const fileId = `SMOKE_FILE_${counter}_${randomUUID().slice(0, 8)}`;
      const uniqueId = `SMOKEU${counter}`;
      const stored = { fileId, uniqueId, filePath: `music/smoke_${counter}`, bytes: part.content, mime: part.type ?? 'application/octet-stream', name: part.filename };
      files.set(fileId, stored);
      messageId += 1;

      const base = { file_id: fileId, file_unique_id: uniqueId, file_size: part.content.length, file_name: part.filename, mime_type: stored.mime };
      const chat = { id: -1001111111111 };

      if (method === 'sendPhoto') {
        return json(res, { ok: true, result: { message_id: messageId, chat, photo: [{ ...base, width: 800, height: 800 }] } });
      }
      if (method === 'sendAudio') {
        const duration = Number(parts.find((p) => p.name === 'duration')?.content.toString('utf8') ?? 0);
        return json(res, { ok: true, result: { message_id: messageId, chat, audio: { ...base, duration } } });
      }
      return json(res, { ok: true, result: { message_id: messageId, chat, document: base } });
    }

    return json(res, { ok: false, error_code: 404, description: `Not Found: ${method}` }, 404);
  });
});

const port = Number(process.argv[2] ?? 8099);
server.listen(port, '127.0.0.1', () => console.log(`fake bot api listening on ${port}`));

/**
 * 最小 Chrome DevTools Protocol 客户端（零依赖，用 node:net 手写 WebSocket 帧）。
 *
 * 为什么不用 ws 包：这是一个只在本机调试用的工具，为它引入一个运行时依赖不值得。
 * CDP 只需要「客户端发文本帧 / 收文本帧」，协议足够简单，百来行即可。
 *
 * 用法: import { connectCdp } from './lib/cdp.mjs'
 */
import { connect } from 'node:net';
import { createHash, randomBytes } from 'node:crypto';

const GUID = '258EAFA5-E914-47DA-95CA-C5AB0DC85B11';

/**
 * 建立到 CDP WebSocket 的连接
 * @param {string} wsUrl 形如 ws://127.0.0.1:9222/devtools/page/XXX
 * @returns {Promise<{send, on, close}>}
 */
export function connectCdp(wsUrl) {
  const u = new URL(wsUrl);
  const key = randomBytes(16).toString('base64');

  return new Promise((resolve, reject) => {
    const socket = connect(Number(u.port), u.hostname, () => {
      socket.write([
        `GET ${u.pathname}${u.search} HTTP/1.1`,
        `Host: ${u.host}`,
        'Upgrade: websocket',
        'Connection: Upgrade',
        `Sec-WebSocket-Key: ${key}`,
        'Sec-WebSocket-Version: 13',
        '', '',
      ].join('\r\n'));
    });

    const handlers = new Map(); // method -> [fn]
    let buffer = Buffer.alloc(0);
    let handshakeDone = false;
    let fragOpcode = 0;
    let fragBuf = Buffer.alloc(0);

    const emit = (method, params) => {
      for (const fn of handlers.get(method) || []) fn(params);
    };

    socket.on('data', (chunk) => {
      buffer = Buffer.concat([buffer, chunk]);

      // 先完成 HTTP 握手
      if (!handshakeDone) {
        const idx = buffer.indexOf('\r\n\r\n');
        if (idx < 0) return;
        const header = buffer.subarray(0, idx).toString();
        buffer = buffer.subarray(idx + 4);
        if (!/101/.test(header.split('\r\n')[0])) {
          reject(new Error(`WebSocket 握手失败: ${header.split('\r\n')[0]}`));
          return;
        }
        handshakeDone = true;
        resolve(api);
      }

      // 解析帧
      while (buffer.length >= 2) {
        const b0 = buffer[0];
        const b1 = buffer[1];
        const fin = (b0 & 0x80) !== 0;
        const opcode = b0 & 0x0f;
        const masked = (b1 & 0x80) !== 0;
        let len = b1 & 0x7f;
        let offset = 2;

        if (len === 126) {
          if (buffer.length < 4) return;
          len = buffer.readUInt16BE(2);
          offset = 4;
        } else if (len === 127) {
          if (buffer.length < 10) return;
          len = Number(buffer.readBigUInt64BE(2));
          offset = 10;
        }
        let maskKey = null;
        if (masked) {
          if (buffer.length < offset + 4) return;
          maskKey = buffer.subarray(offset, offset + 4);
          offset += 4;
        }
        if (buffer.length < offset + len) return;

        let payload = buffer.subarray(offset, offset + len);
        if (maskKey) {
          payload = Buffer.from(payload);
          for (let i = 0; i < payload.length; i++) payload[i] ^= maskKey[i % 4];
        }
        buffer = buffer.subarray(offset + len);

        // 控制帧
        if (opcode === 0x8) { socket.end(); return; }
        if (opcode === 0x9) { writeFrame(socket, 0xA, payload); continue; }
        if (opcode === 0xA) continue;

        // 数据帧（含分片重组）
        if (opcode === 0x0) {
          fragBuf = Buffer.concat([fragBuf, payload]);
          if (fin) { handleMessage(fragBuf.toString('utf8'), emit); fragBuf = Buffer.alloc(0); }
          continue;
        }
        if (!fin) { fragOpcode = opcode; fragBuf = payload; continue; }
        handleMessage(payload.toString('utf8'), emit);
      }
    });

    socket.on('error', reject);

    let msgId = 0;
    const api = {
      /** 发送 CDP 命令 */
      send(method, params = {}) {
        const id = ++msgId;
        writeFrame(socket, 0x1, Buffer.from(JSON.stringify({ id, method, params }), 'utf8'));
        return id;
      },
      /** 监听事件 */
      on(method, fn) {
        if (!handlers.has(method)) handlers.set(method, []);
        handlers.get(method).push(fn);
      },
      close() { try { socket.end(); } catch {} },
    };
  });
}

function handleMessage(text, emit) {
  let msg;
  try { msg = JSON.parse(text); } catch { return; }
  if (msg.method) emit(msg.method, msg.params);
  else if (msg.id) emit(`__id_${msg.id}`, msg.result ?? msg.error);
}

/** 发送一帧（客户端必须掩码） */
function writeFrame(socket, opcode, payload) {
  const len = payload.length;
  let header;
  const mask = randomBytes(4);
  if (len < 126) {
    header = Buffer.alloc(6);
    header[0] = 0x80 | opcode;
    header[1] = 0x80 | len;
    mask.copy(header, 2);
  } else if (len < 65536) {
    header = Buffer.alloc(8);
    header[0] = 0x80 | opcode;
    header[1] = 0x80 | 126;
    header.writeUInt16BE(len, 2);
    mask.copy(header, 4);
  } else {
    header = Buffer.alloc(14);
    header[0] = 0x80 | opcode;
    header[1] = 0x80 | 127;
    header.writeBigUInt64BE(BigInt(len), 2);
    mask.copy(header, 10);
  }
  const masked = Buffer.from(payload);
  for (let i = 0; i < masked.length; i++) masked[i] ^= mask[i % 4];
  socket.write(Buffer.concat([header, masked]));
}

/** 等待某个 CDP 命令的返回 */
export function waitForResult(api, id, timeoutMs = 8000) {
  return new Promise((resolve) => {
    const timer = setTimeout(() => resolve(null), timeoutMs);
    api.on(`__id_${id}`, (result) => { clearTimeout(timer); resolve(result); });
  });
}

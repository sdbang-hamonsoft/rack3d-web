// 의존성 없는 최소 CDP 클라이언트 (WebSocket 프레이밍 직접 구현)
import { createConnection } from 'node:net'
import { randomBytes } from 'node:crypto'

const steps = JSON.parse(process.argv[2])

const targets = await (await fetch('http://localhost:9222/json')).json()
const page = targets.find((t) => t.type === 'page' && t.url.includes('/rack3d/'))
if (!page) { console.error('page target not found:', targets.map((t)=>t.url)); process.exit(1) }
const { hostname, port, pathname } = new URL(page.webSocketDebuggerUrl)

const sock = createConnection({ host: hostname, port: Number(port) })
await new Promise((r) => sock.once('connect', r))
sock.write(`GET ${pathname} HTTP/1.1\r\nHost: ${hostname}:${port}\r\nUpgrade: websocket\r\nConnection: Upgrade\r\nSec-WebSocket-Key: ${randomBytes(16).toString('base64')}\r\nSec-WebSocket-Version: 13\r\n\r\n`)

let buf = Buffer.alloc(0)
let handshakeDone = false
const pending = new Map()

const encode = (payload) => {
  const data = Buffer.from(payload)
  const mask = randomBytes(4)
  const masked = Buffer.from(data.map((b, i) => b ^ mask[i % 4]))
  let head
  if (data.length < 126) head = Buffer.from([0x81, 0x80 | data.length])
  else if (data.length < 65536) { head = Buffer.alloc(4); head[0] = 0x81; head[1] = 0xfe; head.writeUInt16BE(data.length, 2) }
  else { head = Buffer.alloc(10); head[0] = 0x81; head[1] = 0xff; head.writeBigUInt64BE(BigInt(data.length), 2) }
  return Buffer.concat([head, mask, masked])
}

let fragments = []
const drain = () => {
  for (;;) {
    if (buf.length < 2) return
    const fin = (buf[0] & 0x80) !== 0
    const opcode = buf[0] & 0x0f
    let len = buf[1] & 0x7f
    let offset = 2
    if (len === 126) { if (buf.length < 4) return; len = buf.readUInt16BE(2); offset = 4 }
    else if (len === 127) { if (buf.length < 10) return; len = Number(buf.readBigUInt64BE(2)); offset = 10 }
    if (buf.length < offset + len) return
    const payload = buf.subarray(offset, offset + len)
    buf = buf.subarray(offset + len)
    if (opcode === 0x8) return
    fragments.push(Buffer.from(payload))
    if (!fin) continue
    const text = Buffer.concat(fragments).toString('utf8'); fragments = []
    try {
      const msg = JSON.parse(text)
      if (msg.id && pending.has(msg.id)) { pending.get(msg.id)(msg); pending.delete(msg.id) }
    } catch { /* 이벤트 알림은 무시 */ }
  }
}

sock.on('data', (chunk) => {
  if (!handshakeDone) {
    buf = Buffer.concat([buf, chunk])
    const end = buf.indexOf('\r\n\r\n')
    if (end === -1) return
    handshakeDone = true
    buf = buf.subarray(end + 4)
  } else buf = Buffer.concat([buf, chunk])
  drain()
})
while (!handshakeDone) await new Promise((r) => setTimeout(r, 20))

let nextId = 1
const evaluate = (expression) => new Promise((resolve, reject) => {
  const id = nextId++
  pending.set(id, (msg) => {
    if (msg.error) return reject(new Error(JSON.stringify(msg.error)))
    const r = msg.result?.result
    if (msg.result?.exceptionDetails) return reject(new Error(msg.result.exceptionDetails.text + ' ' + (r?.description ?? '')))
    resolve(r?.value)
  })
  sock.write(encode(JSON.stringify({ id, method: 'Runtime.evaluate', params: { expression, returnByValue: true, awaitPromise: true } })))
  setTimeout(() => { if (pending.has(id)) { pending.delete(id); reject(new Error('timeout')) } }, 15000)
})

for (const step of steps) {
  if (step.wait) { await new Promise((r) => setTimeout(r, step.wait)); continue }
  const value = await evaluate(step.eval)
  console.log(`### ${step.label}\n${typeof value === 'string' ? value : JSON.stringify(value)}\n`)
}
sock.end()
process.exit(0)

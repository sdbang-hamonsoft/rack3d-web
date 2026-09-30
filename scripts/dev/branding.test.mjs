import { test } from 'node:test'
import assert from 'node:assert/strict'
import { DEFAULT_PRODUCT_NAME, loadProductName } from '../../src/branding.ts'

test('public branding uses same-origin URL without cookies or authorization', async () => {
  const original = globalThis.fetch
  globalThis.fetch = async (url, options) => {
    assert.equal(url, '/api/auth/branding')
    assert.equal(options.credentials, 'omit')
    assert.equal(options.redirect, 'error')
    assert.equal(options.headers, undefined)
    return Response.json({ productName: '  고객 관제  ' })
  }
  try {
    assert.equal(await loadProductName(new AbortController().signal), '고객 관제')
  } finally { globalThis.fetch = original }
})

test('invalid payload, HTTP and network failures preserve fallback', async () => {
  const original = globalThis.fetch
  try {
    for (const payload of [null, [], {}, { productName: '' }, { productName: '   ' }, { productName: 3 }]) {
      globalThis.fetch = async () => Response.json(payload)
      assert.equal(await loadProductName(new AbortController().signal), DEFAULT_PRODUCT_NAME)
    }
    globalThis.fetch = async () => new Response('', { status: 401 })
    assert.equal(await loadProductName(new AbortController().signal), DEFAULT_PRODUCT_NAME)
    globalThis.fetch = async () => { throw new Error('offline') }
    assert.equal(await loadProductName(new AbortController().signal), DEFAULT_PRODUCT_NAME)
    globalThis.fetch = async () => new Response('<html>login</html>')
    assert.equal(await loadProductName(new AbortController().signal), DEFAULT_PRODUCT_NAME)
  } finally { globalThis.fetch = original }
})

test('timeout and unmount abort pending branding without affecting authentication', async () => {
  const original = globalThis.fetch
  let aborts = 0
  globalThis.fetch = (_url, { signal }) => new Promise((_resolve, reject) => {
    signal.addEventListener('abort', () => { aborts++; reject(new DOMException('Aborted', 'AbortError')) }, { once: true })
  })
  try {
    assert.equal(await loadProductName(new AbortController().signal, 5), DEFAULT_PRODUCT_NAME)
    const unmount = new AbortController()
    const pending = loadProductName(unmount.signal)
    unmount.abort()
    assert.equal(await pending, DEFAULT_PRODUCT_NAME)
    assert.equal(aborts, 2)
    assert.equal(await loadProductName(unmount.signal), DEFAULT_PRODUCT_NAME)
    assert.equal(aborts, 2)
  } finally { globalThis.fetch = original }
})

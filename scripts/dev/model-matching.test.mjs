// Run with Node 24+: node --experimental-strip-types --test scripts/dev/model-matching.test.mjs
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { existsSync } from 'node:fs'
import { pickServerModel, SERVER_MODEL_UNITS, toServerData, standardModelDepth } from '../../src/rackLayouts.ts'

test('vendor matching requires exact model identity and occupied U', () => {
  assert.equal(pickServerModel('Dell', 2, 'PowerEdge R760', 'SERVER'), 'dell-poweredge-r760')
  assert.equal(pickServerModel('HPE', 1, 'ProLiant DL360 Gen11', 'SERVER'), 'hpe-proliant-dl360-gen11')
  assert.equal(pickServerModel('Cisco Systems', 2, 'UCS C240 M7', 'SERVER'), 'cisco-ucs-c240-m7')
  for (const model of ['R760xd', 'R740', null]) assert.equal(pickServerModel('Dell', 2, model, 'SERVER'), 'standard-server-2u')
  assert.equal(pickServerModel('Dell', 4, 'PowerEdge R760', 'SERVER'), 'standard-server-4u')
  assert.equal(pickServerModel('Not Dell', 2, 'R760', 'SERVER'), 'standard-server-2u')
  assert.equal(pickServerModel('Cisco', 1, 'Nexus 93180YC-EX', 'NETWORK'), 'standard-network-1u')
})
test('every standard U resolves to a real asset and correct nominal height', () => {
  for (const category of ['SERVER', 'NETWORK']) for (let units = 1; units <= 10; units++) {
    const model = pickServerModel(null, units, null, category)
    assert.equal(SERVER_MODEL_UNITS[model], units)
    assert.ok(existsSync(new URL(`../../public/models/${model}.glb`, import.meta.url)))
  }
  assert.equal(pickServerModel(null, 12, null, 'NETWORK'), 'standard-network-10u')
  assert.equal(standardModelDepth('standard-network-1u'), .35)
  assert.equal(standardModelDepth('standard-network-4u'), .55)
  assert.equal(standardModelDepth('standard-server-10u'), .8)
})
test('FMS metadata stays intact when an unknown model uses a standard chassis', () => {
  const asset = { id: 1, rackStartU: 3, rackEndU: 5, manufacturer: 'Juniper', modelName: 'Example', category: 'NETWORK', hasFront: true, hasRear: false }
  const result = toServerData(asset)
  assert.equal(result.model, 'standard-network-3u')
  assert.equal(result.manufacturer, 'Juniper')
  assert.equal(result.modelName, 'Example')
  assert.equal(result.units, 3)
  assert.equal(result.startU, 3)
  assert.equal(result.hasFront, true)
  assert.equal(toServerData({ ...asset, rackEndU: 2 }), null)
})

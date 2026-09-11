// Run with Node 24+: node --experimental-strip-types --test scripts/dev/model-matching.test.mjs
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { existsSync } from 'node:fs'
import { pickServerModel, SERVER_MODEL_UNITS, toServerData, standardModelDepth, buildZoneScene } from '../../src/rackLayouts.ts'

test('specific vendor model survives different FMS U spans and categories', () => {
  assert.equal(pickServerModel('Dell', 2, 'PowerEdge R760', 'SERVER'), 'dell-poweredge-r760')
  assert.equal(pickServerModel('HPE', 1, 'ProLiant DL360 Gen11', 'SERVER'), 'hpe-proliant-dl360-gen11')
  assert.equal(pickServerModel('Cisco Systems', 2, 'UCS C240 M7', 'SERVER'), 'cisco-ucs-c240-m7')
  for (const model of ['R760xd', 'R740', null]) assert.equal(pickServerModel('Dell', 2, model, 'SERVER'), 'standard-server-2u')
  assert.equal(pickServerModel('Dell', 4, 'PowerEdge R760', 'SERVER'), 'dell-poweredge-r760')
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

test('explicit Standard codes select the family without relying on category', () => {
  assert.equal(pickServerModel('Standard', 2, 'SDN-u2', null), 'standard-network-2u')
  assert.equal(pickServerModel('Standard', 4, 'SDN-u3', 'SERVER'), 'standard-network-4u')
  assert.equal(pickServerModel('Standard', 3, 'SD-u3', 'NETWORK'), 'standard-server-3u')
  assert.equal(pickServerModel('Cisco', 2, 'UCS C240 M7', 'NETWORK'), 'cisco-ucs-c240-m7')
})
test('model selection cannot change FMS rack membership, coordinates, direction or U placement', () => {
  const racks = [{ locationId: 12, name: 'B', rackUnits: 42 }, { locationId: 11, name: 'A', rackUnits: 42 }]
  const layout = { grid: { cols: 12, rows: 8, tileMm: 600 }, objects: [
    { id: 1, type: 'RACK', x: 4, z: 3, dir: 'WEST', rack: { locationId: 11 } },
    { id: 2, type: 'RACK', x: 2, z: 1, dir: 'EAST', rack: { locationId: 12 } },
  ] }
  for (const [manufacturer, modelName, category, expected] of [
    ['Dell', 'PowerEdge R760', 'SERVER', 'dell-poweredge-r760'],
    ['Standard', 'SDN-u3', 'SERVER', 'standard-network-4u'],
    ['Unknown', 'Unknown', 'SERVER', 'standard-server-4u'],
  ]) {
    const maps = [
      { rack: { locationId: 11 }, assets: [{ id: 101, rackStartU: 7, rackEndU: 10, manufacturer, modelName, category }] },
      { rack: { locationId: 12 }, assets: [] },
    ]
    const before = JSON.stringify({ racks, layout, maps })
    const scene = buildZoneScene(racks, layout, maps)
    const rack = scene.racks.find(r => r.id === 'fms-rack-11')
    assert.deepEqual(rack.placement, { tileX: 4, tileZ: 3, dir: 'WEST', rotation: Math.PI * 1.5 })
    assert.equal(rack.servers[0].assetId, 101)
    assert.equal(rack.servers[0].startU, 7)
    assert.equal(rack.servers[0].units, 4)
    assert.equal(rack.servers[0].model, expected)
    assert.equal(scene.racks.find(r => r.id === 'fms-rack-12').servers.length, 0)
    assert.equal(JSON.stringify({ racks, layout, maps }), before)
  }
})


test('standalone access reader preserves GATE and uses only supplied placement', async () => {
  const { LAYOUT_OBJECT_MODELS } = await import('../../src/rackLayouts.ts')
  const gate = { id: 1, type: 'GATE', x: 2, z: 3, dir: 'EAST', label: 'Gate', rack: null }
  const reader = { id: 2, type: 'ACCESS', x: 5, z: 1, dir: 'WEST', label: 'Reader', rack: null }
  const layout = { grid: { cols: 8, rows: 6, tileMm: 600 }, objects: [gate, reader] }
  const before = JSON.stringify(layout)
  const scene = buildZoneScene([], layout, [])
  assert.equal(scene.objects.length, 2)
  assert.equal(LAYOUT_OBJECT_MODELS.GATE, undefined)
  assert.equal(LAYOUT_OBJECT_MODELS.ACCESS, 'access-tag-reader')
  assert.equal(scene.objects[0].heightM, 1.2)
  assert.equal(scene.objects[1].heightM, .11)
  assert.deepEqual(scene.objects[1].placement, { tileX: 5, tileZ: 1, dir: 'WEST', rotation: Math.PI * 1.5 })
  assert.equal(JSON.stringify(layout), before)
  assert.equal(buildZoneScene([], { ...layout, objects: [gate] }, []).objects.length, 1)
})

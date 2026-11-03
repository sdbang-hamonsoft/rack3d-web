// Run with Node 24+: node --experimental-strip-types --test scripts/dev/facility-status.test.mjs
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { buildZoneScene, objectLabel, parseFacilityStatuses, toObjectAsset } from '../../src/rackLayouts.ts'
import { collectFacilityAlarms, facilityStatusView } from '../../src/rackFigures.ts'

const asset = { assetId: 9, assetCode: 'TH-01', name: '온습도 #1', category: 'SENSOR', monitoringType: 'TH' }
const object = (o) => ({ id: 1, type: 'SENSOR', x: 1, z: 1, dir: 'NORTH', label: '', rack: null, asset: null, ...o })
const status = (o) => ({ assetId: 9, severity: 'NORMAL', stale: false, collectedAt: null, metrics: [], ...o })

test('only the E76 contract counts as a link', () => {
  assert.deepEqual(toObjectAsset(asset), asset)
  assert.equal(toObjectAsset(null), null)
  assert.equal(toObjectAsset(undefined), null)
  // E76 이전 FMS 형태 — 연결로 읽으면 없는 API 를 30초마다 부른다.
  assert.equal(toObjectAsset({ id: 9, code: 'TH-01', name: 'x', category: 'y', monitoringType: 'z', images: null }), null)
  for (const assetId of [0, -1, 1.5, '9', null]) assert.equal(toObjectAsset({ ...asset, assetId }), null)
  assert.deepEqual(toObjectAsset({ assetId: 9 }), { assetId: 9, assetCode: null, name: null, category: null, monitoringType: null })
})

test('label prefers FMS label, then asset name, then type', () => {
  assert.equal(objectLabel(object({ label: '센서A', asset })), '센서A')
  assert.equal(objectLabel(object({ label: ' ', asset })), '온습도 #1')
  assert.equal(objectLabel(object({ asset: { assetId: 9 } })), 'SENSOR')
  assert.equal(objectLabel(object({ asset: { id: 9, name: '옛 형태' } })), 'SENSOR')
})

test('scene carries the link and keeps unlinked objects as they were', () => {
  const layout = { zone: { id: 1, name: 'z', code: null }, grid: { cols: 4, rows: 4, tileMm: 600, ceilingMm: null }, objects: [
    object({ id: 1, asset }),
    object({ id: 2, x: 2, asset: null }),
    object({ id: 3, x: 3, asset: { id: 9 } }),
  ] }
  const { objects } = buildZoneScene([], layout, [])
  assert.deepEqual(objects.map((o) => o.asset?.assetId ?? null), [9, null, null])
})

test('only an FMS NORMAL verdict reads as normal', () => {
  assert.deepEqual(facilityStatusView(status({}), false), { tone: 'normal', label: '정상', alarm: false })
  assert.deepEqual(facilityStatusView(undefined, false), { tone: 'unknown', label: '상태 없음', alarm: false })
  assert.deepEqual(facilityStatusView(status({ severity: null }), false), { tone: 'unknown', label: '상태 없음', alarm: false })
  assert.deepEqual(facilityStatusView(status({ stale: true }), false), { tone: 'stale', label: '통신두절', alarm: false })
  assert.deepEqual(facilityStatusView(status({ severity: null, stale: true }), false), { tone: 'stale', label: '통신두절', alarm: false })
  assert.deepEqual(facilityStatusView(status({}), true), { tone: 'unknown', label: '상태 미갱신', alarm: false })
  assert.deepEqual(facilityStatusView(undefined, true), { tone: 'unknown', label: '상태 미갱신', alarm: false })
})

test('an alarm is never hidden by stale data or a failed feed', () => {
  assert.deepEqual(facilityStatusView(status({ severity: 'CRITICAL' }), false), { tone: 'critical', label: '심각', alarm: true })
  assert.deepEqual(facilityStatusView(status({ severity: 'CAUTION' }), false), { tone: 'warning', label: '주의', alarm: true })
  assert.deepEqual(facilityStatusView(status({ severity: 'MAJOR', stale: true }), false), { tone: 'warning', label: '경고 · 통신두절', alarm: true })
  assert.deepEqual(facilityStatusView(status({ severity: 'CRITICAL', stale: true }), true), { tone: 'critical', label: '심각 · 미갱신', alarm: true })
  // 모르는 등급(C5)은 원값을 보여주고 정상처럼 두지 않는다.
  assert.deepEqual(facilityStatusView(status({ severity: 'NEW_LEVEL' }), false), { tone: 'warning', label: 'NEW_LEVEL', alarm: true })
})

test('a response of the wrong shape is a failure, and broken items are dropped', () => {
  for (const raw of [{ content: [] }, null, 'x', 7]) assert.equal(parseFacilityStatuses(raw), null)
  assert.deepEqual(parseFacilityStatuses([]), [])
  assert.deepEqual(parseFacilityStatuses([null, 7, { assetId: 'x' }, { assetId: 0 }]), [])
  assert.deepEqual(
    parseFacilityStatuses([{ assetId: 9, severity: { a: 1 }, stale: 'yes', collectedAt: 'garbage', metrics: [null, { key: 'k', value: { b: 2 }, unit: 3 }, { value: 1 }] }]),
    [{ assetId: 9, severity: null, stale: false, collectedAt: null, metrics: [{ key: 'k', value: null, unit: null }] }],
  )
  assert.equal(parseFacilityStatuses([{ assetId: 9, severity: 'constructor' }])[0].severity, null)
  assert.equal(parseFacilityStatuses([{ assetId: 9, severity: 'NEW_LEVEL' }])[0].severity, 'NEW_LEVEL')
  assert.deepEqual(parseFacilityStatuses([{ assetId: 9, metrics: [{ key: 't', value: 0, unit: 'C' }] }])[0].metrics, [{ key: 't', value: 0, unit: 'C' }])
})

test('an alarm with nowhere to draw is still reported', () => {
  const layout = { zone: { id: 1, name: 'z', code: null }, grid: { cols: 2, rows: 2, tileMm: 600, ceilingMm: null }, objects: [
    object({ id: 1, x: 9999, z: 0, asset }),
  ] }
  const scene = buildZoneScene([], layout, [])
  assert.deepEqual(scene.objects, [])
  assert.deepEqual(scene.unplacedFacilityAssets.map((a) => a.assetId), [9])
  const statuses = new Map([[9, status({ severity: 'CRITICAL' })], [5, status({ assetId: 5, severity: 'MAJOR' })], [6, status({ assetId: 6 })]])
  const alarms = collectFacilityAlarms(scene.objects, scene.unplacedFacilityAssets, statuses, false)
  assert.deepEqual(alarms.map((a) => [a.label, a.object]), [['온습도 #1 (3D 미배치)', null], ['자산 5 (3D 미배치)', null]])
})

test('alarms sort by severity, not tone', () => {
  const sceneObject = (id, assetId) => ({ id, type: 'SENSOR', label: id, color: '#000', heightM: 1, placement: null, asset: { assetId } })
  const objects = [1, 2, 3, 4, 5, 6].map((n) => sceneObject(`o${n}`, n))
  const severities = { 1: 'CAUTION', 2: 'CAUTION', 3: 'NORMAL', 4: 'MAJOR', 5: 'CAUTION', 6: 'CRITICAL' }
  const statuses = new Map(Object.entries(severities).map(([id, severity]) => [Number(id), status({ assetId: Number(id), severity })]))
  assert.deepEqual(collectFacilityAlarms(objects, [], statuses, false).map((a) => a.key), ['o6', 'o4', 'o1', 'o2', 'o5'])
})

// Run with Node 24+: node --experimental-strip-types --test scripts/dev/facility-status.test.mjs
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { buildZoneScene, objectLabel, parseFacilityStatuses, toObjectAsset } from '../../src/rackLayouts.ts'
import { facilityLabelStatus } from '../../src/rackFigures.ts'

const asset = { assetId: 9, name: '온습도 #1', monitoringType: 'TH' }
const object = (o) => ({ id: 1, type: 'SENSOR', x: 1, z: 1, dir: 'NORTH', label: '', rack: null, asset: null, ...o })
const status = (o) => ({ assetId: 9, severity: 'NORMAL', stale: false, collectedAt: '2026-11-03T03:12:40Z', metrics: [], commStatus: 'ONLINE', ...o })
const metric = (key, value) => ({ key, value })
const label = (monitoringType, s, feedFailed = false) => facilityLabelStatus({ assetId: 9, name: null, monitoringType }, s, feedFailed)

test('the requested example renders line for line', () => {
  const crac = status({ severity: 'CRITICAL', metrics: [metric('operating_state', '송풍, 냉방'), metric('temp', 22.8), metric('humidity', 22.9), metric('alm_filter', true), metric('alm_sensor', false)] })
  assert.deepEqual(label('HVAC', crac), { tone: 'danger', prefix: '⚠️ [경보] ', lines: ['상태: 송풍, 냉방', '22.8 °C / 22.9 %', '접점 경보 1건'] })
})

test('only the E76 contract counts as a link', () => {
  assert.deepEqual(toObjectAsset({ ...asset, assetCode: 'x', id: 9, images: null }), asset)
  assert.equal(toObjectAsset(null), null)
  // E76 이전 FMS 형태 — assetId 가 없어 상태와 이을 수 없다.
  assert.equal(toObjectAsset({ id: 9, code: 'TH-01', name: 'x' }), null)
  for (const assetId of [0, -1, 1.5, '9', null]) assert.equal(toObjectAsset({ ...asset, assetId }), null)
})

test('label prefers FMS label, then asset name, then type', () => {
  assert.equal(objectLabel(object({ label: '누수감지-01', asset })), '누수감지-01')
  assert.equal(objectLabel(object({ label: ' ', asset })), '온습도 #1')
  assert.equal(objectLabel(object({ asset: { assetId: 9 } })), 'SENSOR')
})

test('scene keeps unlinked objects as they were', () => {
  const layout = { zone: { id: 1, name: 'z', code: null }, grid: { cols: 4, rows: 4, tileMm: 600, ceilingMm: null }, objects: [
    object({ id: 1, asset }),
    object({ id: 2, x: 2 }),
    object({ id: 3, x: 3, asset: { id: 9 } }),
  ] }
  assert.deepEqual(buildZoneScene([], layout, []).objects.map((o) => o.asset?.assetId ?? null), [9, null, null])
})

test('a response of the wrong shape is a failure, and broken items are dropped', () => {
  for (const raw of [{ content: [] }, null, 'x', 7]) assert.equal(parseFacilityStatuses(raw), null)
  assert.deepEqual(parseFacilityStatuses([null, 7, { assetId: 'x' }, { assetId: 0 }]), [])
  assert.deepEqual(
    parseFacilityStatuses([{ assetId: 9, severity: { a: 1 }, stale: 'yes', collectedAt: 'garbage', commStatus: 'WEIRD', metrics: [null, { key: 'k', value: { b: 2 } }, { value: 1 }] }]),
    [{ assetId: 9, severity: null, stale: false, collectedAt: null, metrics: [{ key: 'k', value: null }], commStatus: null }],
  )
  assert.equal(parseFacilityStatuses([{ assetId: 9, severity: 'constructor' }])[0].severity, null)
  const metrics = [metric('t', 0), metric('a', false), metric('b', true), metric('o', '송풍'), metric('h', null)]
  assert.deepEqual(parseFacilityStatuses([{ assetId: 9, metrics }])[0].metrics, metrics)
})

test('lines match the FMS pin popup wording', () => {
  assert.deepEqual(label('TH', status({ metrics: [metric('temp', 23.46), metric('humidity', null)] })).lines, ['온도: 23.5 °C'])
  assert.deepEqual(label('HVAC', status({ metrics: [metric('operating_state', '송풍, 냉방'), metric('temp', 22), metric('humidity', 45), metric('alm_a', true), metric('alm_b', false)] })).lines, ['상태: 송풍, 냉방', '22.0 °C / 45.0 %', '접점 경보 1건'])
  assert.deepEqual(label('UPS', status({ metrics: [metric('battery_soc', 100), metric('active_power', 12.34), metric('battery_backup_min', 30)] })).lines, ['배터리: 100 % | 출력: 12.3 kW', '백업 가능: 30 분'])
  assert.deepEqual(label('DPM', status({ metrics: [metric('active_power', 142.8), metric('volt_r', 220)] })).lines, ['전력: 142.8 kW | 전압: 220 V'])
  assert.deepEqual(label('LEAK', status({ metrics: [metric('leak_detected', false)] })).lines, ['상태: 정상'])
  assert.deepEqual(label('FIRE', status({ metrics: [metric('fire_detected', false), metric('smoke_density', 1.26)] })).lines, ['상태: 정상', '연기 농도: 1.3 %'])
})

test('without metrics permission the verdict still shows', () => {
  assert.deepEqual(label('UPS', status({})), { tone: 'normal', prefix: '', lines: ['상태: 정상'] })
  assert.deepEqual(label('UPS', status({ severity: 'MAJOR' })), { tone: 'danger', prefix: '⚠️ [경보] ', lines: [] })
  assert.deepEqual(label('ACCESS', status({ severity: 'CAUTION' })), { tone: 'warning', prefix: '⚠️ [주의] ', lines: [] })
})

test('comm status follows FMS, and the worse tone wins', () => {
  assert.deepEqual(label('TH', status({ commStatus: 'OFFLINE', stale: true })), { tone: 'danger', prefix: '⚠️ [경보] ', lines: ['통신: 두절'] })
  assert.deepEqual(label('TH', status({ commStatus: 'STALE', stale: true })), { tone: 'warning', prefix: '⚠️ [주의] ', lines: ['통신: 지연'] })
  assert.deepEqual(label('TH', status({ commStatus: 'UNKNOWN' })), { tone: 'muted', prefix: '', lines: ['통신: 미상'] })
  assert.equal(label('TH', status({ severity: 'CAUTION', commStatus: 'OFFLINE', stale: true })).tone, 'danger')
  assert.equal(label('TH', status({ severity: 'CRITICAL', commStatus: 'STALE', stale: true })).tone, 'danger')
  assert.deepEqual(label('TH', status({ commStatus: null, stale: true })), { tone: 'muted', prefix: '', lines: ['통신: 이상'] })
})

test('unknown state never reads as normal', () => {
  assert.deepEqual(label('TH', undefined), { tone: 'muted', prefix: '', lines: ['상태 없음'] })
  assert.deepEqual(label('TH', status({ severity: null })), { tone: 'muted', prefix: '', lines: ['상태 없음'] })
  // E76 계약: 수집 전·비수집 자산도 NORMAL 로 온다.
  assert.deepEqual(label(null, status({ collectedAt: null, commStatus: 'UNKNOWN' })), { tone: 'muted', prefix: '', lines: ['미수집'] })
  assert.deepEqual(label('TH', status({}), true), { tone: 'muted', prefix: '', lines: ['상태: 정상', '상태 미갱신'] })
  assert.deepEqual(label('TH', undefined, true), { tone: 'muted', prefix: '', lines: ['상태 미갱신'] })
})

test('an alarm stays visible when the feed fails', () => {
  assert.deepEqual(label('LEAK', status({ severity: 'CRITICAL', metrics: [metric('leak_detected', true)] }), true), { tone: 'danger', prefix: '⚠️ [경보] ', lines: ['상태: 누수 감지', '상태 미갱신'] })
  assert.deepEqual(label('TH', status({ commStatus: 'OFFLINE', stale: true }), true), { tone: 'danger', prefix: '⚠️ [경보] ', lines: ['통신: 두절', '상태 미갱신'] })
  // 모르는 등급은 정상처럼 두지 않는다.
  assert.deepEqual(label('TH', status({ severity: 'NEW_LEVEL' })), { tone: 'warning', prefix: '⚠️ [주의] ', lines: ['판정: NEW_LEVEL'] })
})

test('a single clear contact never claims the whole device is normal', () => {
  const fire = [metric('fire_detected', false), metric('smoke_detected', true)]
  assert.deepEqual(label('FIRE', status({ metrics: fire })), { tone: 'warning', prefix: '⚠️ [주의] ', lines: ['접점 경보 1건'] })
  assert.deepEqual(label('FIRE', status({ severity: 'CRITICAL', metrics: fire })), { tone: 'danger', prefix: '⚠️ [경보] ', lines: ['접점 경보 1건'] })
  const leak = [metric('leak_detected', false)]
  assert.deepEqual(label('LEAK', status({ commStatus: 'OFFLINE', stale: true, metrics: leak })), { tone: 'danger', prefix: '⚠️ [경보] ', lines: ['통신: 두절'] })
  assert.deepEqual(label('LEAK', status({ severity: 'MAJOR', metrics: leak })), { tone: 'danger', prefix: '⚠️ [경보] ', lines: [] })
})

test('contacts count for every device type, and a true contact is not normal tone', () => {
  assert.deepEqual(label('UPS', status({ metrics: [metric('battery_soc', 90), metric('alm_input', true)] })), { tone: 'warning', prefix: '⚠️ [주의] ', lines: ['배터리: 90 %', '접점 경보 1건'] })
  assert.deepEqual(label('DPM', status({ metrics: [metric('blackout_detected', true)] })), { tone: 'warning', prefix: '⚠️ [주의] ', lines: ['접점 경보 1건'] })
  assert.deepEqual(label('LEAK', status({ metrics: [metric('leak_detected', true)] })), { tone: 'warning', prefix: '⚠️ [주의] ', lines: ['상태: 누수 감지'] })
  // 가동 접점은 경보가 아니다.
  assert.equal(label('HVAC', status({ metrics: [metric('run_state', true)] })).tone, 'normal')
})


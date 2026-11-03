// Run with Node 24+: node --experimental-strip-types --test scripts/dev/facility-status.test.mjs
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { buildZoneScene, collectApproximatePins, layoutLinkMismatchKey, objectLabel, parseFacilityStatuses, toObjectAsset } from '../../src/rackLayouts.ts'
import { collectFacilityAlarms, facilityMetricsNote, facilityPinCard, facilityPinIcon, facilityPinTitle, facilityStatusView } from '../../src/rackFigures.ts'

const asset = { assetId: 9, assetCode: 'TH-01', name: '온습도 #1', category: 'SENSOR', monitoringType: 'TH' }
const object = (o) => ({ id: 1, type: 'SENSOR', x: 1, z: 1, dir: 'NORTH', label: '', rack: null, asset: null, ...o })
const status = (o) => ({ assetId: 9, severity: 'NORMAL', stale: false, collectedAt: '2026-11-03T03:12:40Z', metrics: [], ...o })

test('only the E76 contract counts as a link', () => {
  assert.deepEqual(toObjectAsset(asset), asset)
  assert.equal(toObjectAsset(null), null)
  assert.equal(toObjectAsset(undefined), null)
  // E76 이전 FMS 형태 — assetId 가 없어 상태와 이을 수 없다.
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

test('NORMAL without any received value is not normal', () => {
  // E76 계약: 수집 전·비수집 자산도 severity NORMAL 로 온다.
  assert.deepEqual(facilityStatusView(status({ collectedAt: null }), false), { tone: 'unknown', label: '미수집', alarm: false })
  assert.deepEqual(facilityStatusView(status({ collectedAt: null, severity: 'MAJOR' }), false), { tone: 'critical', label: '경고', alarm: true })
})

test('empty metrics say why they are empty', () => {
  for (const type of ['TH', 'HVAC', 'UPS', 'DPM', 'LEAK', 'FIRE']) assert.match(facilityMetricsNote(type, status({})), /권한이 없습니다/)
  for (const type of ['ACCESS', 'NVR', null]) assert.match(facilityMetricsNote(type, status({})), /제공하지 않습니다/)
  assert.match(facilityMetricsNote('TH', undefined), /받은 측정값이 없습니다/)
})

test('only an FMS NORMAL verdict reads as normal', () => {
  assert.deepEqual(facilityStatusView(status({}), false), { tone: 'normal', label: '정상', alarm: false })
  assert.deepEqual(facilityStatusView(undefined, false), { tone: 'unknown', label: '상태 없음', alarm: false })
  assert.deepEqual(facilityStatusView(status({ severity: null }), false), { tone: 'unknown', label: '상태 없음', alarm: false })
  assert.deepEqual(facilityStatusView(status({ stale: true }), false), { tone: 'stale', label: '통신 이상', alarm: false })
  assert.deepEqual(facilityStatusView(status({ severity: null, stale: true }), false), { tone: 'stale', label: '통신 이상', alarm: false })
  assert.deepEqual(facilityStatusView(status({}), true), { tone: 'unknown', label: '상태 미갱신', alarm: false })
  assert.deepEqual(facilityStatusView(undefined, true), { tone: 'unknown', label: '상태 미갱신', alarm: false })
})

test('an alarm is never hidden by stale data or a failed feed', () => {
  assert.deepEqual(facilityStatusView(status({ severity: 'CRITICAL' }), false), { tone: 'critical', label: '심각', alarm: true })
  assert.deepEqual(facilityStatusView(status({ severity: 'CAUTION' }), false), { tone: 'warning', label: '주의', alarm: true })
  assert.deepEqual(facilityStatusView(status({ severity: 'MAJOR', stale: true }), false), { tone: 'critical', label: '경고 · 통신 이상', alarm: true })
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
    [{ assetId: 9, severity: null, stale: false, collectedAt: null, metrics: [{ key: 'k', name: null, value: null, unit: null }], name: null, assetCode: null, category: null, monitoringType: null, pin: null, layoutLinked: null, commStatus: null }],
  )
  assert.equal(parseFacilityStatuses([{ assetId: 9, severity: 'constructor' }])[0].severity, null)
  assert.equal(parseFacilityStatuses([{ assetId: 9, severity: 'NEW_LEVEL' }])[0].severity, 'NEW_LEVEL')
  const metrics = [
    { key: 't', name: '온도', value: 0, unit: '℃' },
    { key: 'alm', name: '경보', value: false, unit: null },
    { key: 'leak', name: '누수', value: true, unit: null },
    { key: 'op', name: '운전상태', value: '송풍, 냉방', unit: null },
    { key: 'h', name: '습도', value: null, unit: '%' },
  ]
  assert.deepEqual(parseFacilityStatuses([{ assetId: 9, metrics }])[0].metrics, metrics)
})

test('an alarm with nowhere to draw is still reported', () => {
  const layout = { zone: { id: 1, name: 'z', code: null }, grid: { cols: 2, rows: 2, tileMm: 600, ceilingMm: null }, objects: [
    object({ id: 1, x: 9999, z: 0, asset }),
  ] }
  const scene = buildZoneScene([], layout, [])
  assert.deepEqual(scene.objects, [])
  assert.deepEqual(scene.unplacedFacilityAssets.map((a) => a.assetId), [9])
  const statuses = new Map([
    [9, status({ severity: 'CAUTION' })],
    [5, status({ assetId: 5, severity: 'MAJOR' })],
    [4, status({ assetId: 4, severity: 'CRITICAL' })],
    [6, status({ assetId: 6 })],
  ])
  const alarms = collectFacilityAlarms(scene.objects, scene.unplacedFacilityAssets, statuses, new Set(), false)
  // 이름을 아는 것은 이름으로, 모르는 자산은 id 없이 묶고 그 중 가장 심각한 등급을 보인다.
  assert.deepEqual(alarms.map((a) => [a.label, a.count, a.view.label, a.assetId]), [
    ['3D 미연결 설비 2건', 2, '심각', null],
    ['온습도 #1 (3D 미배치)', 1, '주의', null],
  ])
})

test('alarms sort by severity, not tone', () => {
  const sceneObject = (id, assetId) => ({ id, type: 'SENSOR', label: id, color: '#000', heightM: 1, placement: null, asset: { assetId } })
  const objects = [1, 2, 3, 4, 5, 6].map((n) => sceneObject(`o${n}`, n))
  const severities = { 1: 'CAUTION', 2: 'CAUTION', 3: 'NORMAL', 4: 'MAJOR', 5: 'CAUTION', 6: 'CRITICAL' }
  const statuses = new Map(Object.entries(severities).map(([id, severity]) => [Number(id), status({ assetId: Number(id), severity })]))
  assert.deepEqual(collectFacilityAlarms(objects, [], statuses, new Set(), false).map((a) => a.key), ['o6', 'o4', 'o1', 'o2', 'o5'])
})

const grid = { cols: 10, rows: 5, tileSize: 0.6 }
const linked = (assetId) => ({ id: `o${assetId}`, type: 'SENSOR', label: 'x', color: '#000', heightM: 1, placement: null, asset: { assetId } })

test('pin fields parse safely', () => {
  const [full] = parseFacilityStatuses([{ assetId: 9, name: '센서', assetCode: 'C', category: 'SENSOR', monitoringType: 'TH', pin: { x: 0.25, y: 1.5 } }])
  assert.deepEqual(full.pin, { x: 0.25, y: 1 })
  assert.equal(full.name, '센서')
  for (const pin of [null, undefined, 'x', { x: 'a', y: 1 }, { x: 1 }, { x: NaN, y: 1 }]) {
    assert.equal(parseFacilityStatuses([{ assetId: 9, pin }])[0].pin, null)
  }
})

test('an asset is drawn in one place only, decided by the scene', () => {
  const statuses = [
    status({ assetId: 1, pin: { x: 0, y: 0 } }),
    status({ assetId: 2, pin: { x: 1, y: 1 } }),
    status({ assetId: 3, pin: null }),
    // layoutLinked 플래그가 어긋나도(배치는 진입 시 1회) 씬에 있으면 다시 그리지 않는다.
    status({ assetId: 4, pin: { x: 0.5, y: 0.5 }, layoutLinked: false }),
    status({ assetId: 5, pin: { x: 0.5, y: 0.5 }, layoutLinked: true }),
  ]
  const pins = collectApproximatePins([linked(4)], statuses, grid)
  assert.deepEqual(pins.map((pin) => pin.assetId).sort(), [1, 2, 5])
  assert.deepEqual(collectApproximatePins([], statuses, null), [])
})

test('approximate tile matches the FMS editor suggestion', () => {
  const at = (x, y) => {
    const [pin] = collectApproximatePins([], [status({ pin: { x, y } })], grid)
    return [+pin.worldX.toFixed(3), +pin.worldZ.toFixed(3)]
  }
  // cols 10·rows 5·tile 0.6 — col = min(9, floor(x*10)), row = min(4, floor(y*5)), 칸 중심 = index*tile.
  assert.deepEqual(at(0, 0), [0, 0])
  assert.deepEqual(at(0.25, 0.5), [1.2, 1.2])
  assert.deepEqual(at(1, 1), [5.4, 2.4])
})

test('pins sharing a tile spread apart in a stable order', () => {
  const statuses = [status({ assetId: 8, pin: { x: 0.25, y: 0.5 } }), status({ assetId: 3, pin: { x: 0.26, y: 0.51 } })]
  const pins = collectApproximatePins([], statuses, grid)
  assert.deepEqual(pins.map((pin) => pin.assetId), [3, 8])
  assert.notDeepEqual([pins[0].worldX, pins[0].worldZ], [pins[1].worldX, pins[1].worldZ])
  for (const pin of pins) assert.ok(Math.hypot(pin.worldX - 1.2, pin.worldZ - 1.2) <= 0.3)
  // 응답 순서가 바뀌어도 자리는 같다.
  assert.deepEqual(collectApproximatePins([], [...statuses].reverse(), grid), pins)
})

test('layout refresh is requested only for a real link mismatch', () => {
  const statuses = [
    status({ assetId: 1, layoutLinked: true }),
    status({ assetId: 2, layoutLinked: false }),
    status({ assetId: 3, layoutLinked: true }),
    status({ assetId: 4, layoutLinked: false }),
    status({ assetId: 5, layoutLinked: null }),
    status({ assetId: 6, layoutLinked: true }),
  ]
  // 1: 그려짐(일치) / 2: 없음(일치) / 3: 연결인데 씬에 없음 / 4: 끊겼는데 씬에 있음 / 5: 옛 FMS / 6: 그리드 밖(일치)
  assert.equal(layoutLinkMismatchKey([linked(1), linked(4)], [{ assetId: 6 }], statuses), '3,4')
  assert.equal(layoutLinkMismatchKey([linked(1), linked(3)], [{ assetId: 6 }], statuses.slice(0, 3)), '')
})

test('alarm strip and card use the same name', () => {
  const statuses = new Map([[9, status({ severity: 'MAJOR' })]])
  const object = { id: 'o', type: 'SENSOR', label: 'TH-라벨', color: '#000', heightM: 1, placement: null, asset: { assetId: 9, name: '온습도 #1' } }
  assert.equal(collectFacilityAlarms([object], [], statuses, new Set(), false)[0].label, '온습도 #1')
})

test('alarm on a drawn pin can be opened; without a grid it is still reported', () => {
  const statuses = new Map([[7, status({ assetId: 7, severity: 'MAJOR', name: '센서7', pin: { x: 0, y: 0 } })]])
  assert.deepEqual(collectFacilityAlarms([], [], statuses, new Set([7]), false).map((a) => [a.label, a.assetId]), [['센서7', 7]])
  assert.deepEqual(collectFacilityAlarms([], [], statuses, new Set(), false).map((a) => [a.label, a.assetId]), [['센서7 (3D 미배치)', null]])
})

test('pin card matches the FMS card wording and tones', () => {
  const card = (meta, s, feedFailed = false) => facilityPinCard(meta, s, facilityStatusView(s, feedFailed))
  const th = { category: 'SENSOR', monitoringType: 'TH' }
  const metric = (key, value) => ({ key, name: null, value, unit: null })
  assert.deepEqual(card(th, status({ metrics: [metric('temp', 23.46), metric('humidity', null)] })), { icon: '🌡️', tone: 'normal', prefix: '', lines: ['온도: 23.5 °C'] })
  assert.equal(card(th, status({ severity: 'MAJOR' })).tone, 'danger')
  assert.equal(card(th, status({ severity: 'CRITICAL' })).prefix, '⚠️ [경보] ')
  assert.equal(card(th, status({ severity: 'CAUTION' })).prefix, '⚠️ [주의] ')
  assert.deepEqual(card({ category: 'HVAC', monitoringType: 'HVAC' }, status({ metrics: [metric('operating_state', '송풍, 냉방'), metric('temp', 22), metric('humidity', 45), metric('alm_a', true), metric('alm_b', false)] })).lines, ['상태: 송풍, 냉방', '22.0 °C / 45.0 %', '접점 경보 1건'])
  assert.deepEqual(card({ category: 'POWER', monitoringType: 'UPS' }, status({ metrics: [metric('battery_soc', 100), metric('active_power', 12.34), metric('battery_backup_min', 30)] })).lines, ['배터리: 100 % | 출력: 12.3 kW', '백업 가능: 30 분'])
  assert.deepEqual(card({ category: 'SENSOR', monitoringType: 'LEAK' }, status({ metrics: [metric('leak_detected', true)] })).lines, ['상태: 누수 감지'])
  assert.deepEqual(card({ category: 'SENSOR', monitoringType: 'FIRE' }, status({ metrics: [metric('fire_detected', false), metric('smoke_density', 1.26)] })).lines, ['상태: 정상', '연기 농도: 1.3 %'])
  assert.deepEqual(card({ category: 'POWER', monitoringType: 'DPM' }, status({ metrics: [metric('active_power', 142.8), metric('volt_r', 220)] })).lines, ['전력: 142.8 kW | 전압: 220 V'])
})

test('comm status follows the FMS labels and tones, worse tone wins', () => {
  const view = (o) => facilityStatusView(status(o), false)
  const card = (o) => facilityPinCard({ category: 'SENSOR', monitoringType: 'TH' }, status(o), view(o))
  assert.deepEqual(view({ commStatus: 'OFFLINE', stale: true }), { tone: 'critical', label: '통신 두절', alarm: true })
  assert.deepEqual(view({ commStatus: 'STALE', stale: true }), { tone: 'warning', label: '통신 지연', alarm: true })
  assert.deepEqual(view({ commStatus: 'ONLINE' }), { tone: 'normal', label: '정상', alarm: false })
  assert.deepEqual(view({ commStatus: 'UNKNOWN' }), { tone: 'unknown', label: '통신 미상', alarm: false })
  // 비수집 자산은 UNKNOWN + collectedAt null — 미수집 한 줄이면 된다.
  assert.deepEqual(view({ commStatus: 'UNKNOWN', collectedAt: null }), { tone: 'unknown', label: '미수집', alarm: false })
  assert.deepEqual(card({ commStatus: 'UNKNOWN', collectedAt: null }).lines, ['미수집'])
  assert.deepEqual(card({ commStatus: 'UNKNOWN' }).lines, ['통신: 미상'])
  assert.deepEqual(card({ commStatus: 'ONLINE' }).lines, [])

  assert.deepEqual([card({ commStatus: 'OFFLINE', stale: true }).tone, card({ commStatus: 'OFFLINE', stale: true }).prefix, card({ commStatus: 'OFFLINE', stale: true }).lines], ['danger', '⚠️ [경보] ', ['통신: 두절']])
  assert.deepEqual([card({ commStatus: 'STALE', stale: true }).tone, card({ commStatus: 'STALE', stale: true }).prefix, card({ commStatus: 'STALE', stale: true }).lines], ['warning', '⚠️ [주의] ', ['통신: 지연']])
  // 더 나쁜 쪽: 주의 + 두절은 빨강, 심각 + 지연도 빨강.
  assert.deepEqual(view({ severity: 'CAUTION', commStatus: 'OFFLINE', stale: true }), { tone: 'critical', label: '주의 · 통신 두절', alarm: true })
  assert.equal(card({ severity: 'CAUTION', commStatus: 'OFFLINE', stale: true }).tone, 'danger')
  assert.equal(card({ severity: 'CRITICAL', commStatus: 'STALE', stale: true }).tone, 'danger')
  assert.equal(card({ severity: 'CAUTION', commStatus: 'STALE', stale: true }).tone, 'warning')
  // 갱신 실패여도 마지막 통신 경보를 숨기지 않는다.
  assert.deepEqual(facilityStatusView(status({ commStatus: 'OFFLINE', stale: true }), true), { tone: 'critical', label: '통신 두절 · 미갱신', alarm: true })
  const failed = status({ commStatus: 'OFFLINE', stale: true })
  assert.deepEqual(facilityPinCard({ category: 'SENSOR', monitoringType: 'TH' }, failed, facilityStatusView(failed, true)).lines, ['통신: 두절', '상태 미갱신'])
  // 등급 강조는 FMS 카드와 같다 — 경고는 빨강이고 카드와 띠가 같은 색이다.
  const major = status({ severity: 'MAJOR', commStatus: 'ONLINE' })
  assert.equal(facilityStatusView(major, false).tone, 'critical')
  assert.equal(facilityPinCard({ category: 'SENSOR', monitoringType: 'TH' }, major, facilityStatusView(major, false)).tone, 'danger')
})

test('unexpected comm values fall back to stale', () => {
  assert.equal(parseFacilityStatuses([{ assetId: 9, commStatus: 'WEIRD', stale: true }])[0].commStatus, null)
  assert.equal(parseFacilityStatuses([{ assetId: 9, commStatus: 'OFFLINE' }])[0].commStatus, 'OFFLINE')
  assert.equal(parseFacilityStatuses([{ assetId: 9, layoutLinked: 'yes' }])[0].layoutLinked, null)
})

test('alarm order: critical, then major and offline, then caution and delayed', () => {
  const sceneObject = (assetId) => ({ id: `o${assetId}`, type: 'SENSOR', label: `o${assetId}`, color: '#000', heightM: 1, placement: null, asset: { assetId } })
  const rows = [
    status({ assetId: 1, severity: 'NORMAL', commStatus: 'STALE', stale: true }),
    status({ assetId: 2, severity: 'NORMAL', commStatus: 'OFFLINE', stale: true }),
    status({ assetId: 3, severity: 'CAUTION' }),
    status({ assetId: 4, severity: 'CRITICAL' }),
    status({ assetId: 5, severity: 'MAJOR' }),
  ]
  const statuses = new Map(rows.map((row) => [row.assetId, row]))
  assert.deepEqual(collectFacilityAlarms(rows.map((row) => sceneObject(row.assetId)), [], statuses, new Set(), false).map((a) => a.key), ['o4', 'o2', 'o5', 'o1', 'o3'])
})

test('pin card never passes unknown state off as normal', () => {
  const card = (s, feedFailed = false) => facilityPinCard({ category: 'CCTV', monitoringType: null }, s, facilityStatusView(s, feedFailed))
  assert.deepEqual(card(undefined), { icon: '📹', tone: 'muted', prefix: '', lines: ['상태 없음'] })
  assert.deepEqual(card(status({ collectedAt: null })).lines, ['미수집'])
  assert.equal(card(status({ collectedAt: null })).tone, 'muted')
  assert.deepEqual(card(status({ stale: true })), { icon: '📹', tone: 'stale', prefix: '', lines: ['통신: 이상'] })
  assert.deepEqual(card(status({}), true), { icon: '📹', tone: 'muted', prefix: '', lines: ['상태 미갱신'] })
  assert.deepEqual(card(status({ severity: 'CRITICAL', stale: true }), true).lines, ['상태 미갱신'])
  assert.equal(card(status({ severity: 'CRITICAL', stale: true })).tone, 'danger')
  assert.deepEqual(card(status({ severity: 'CRITICAL', stale: true })).lines, ['통신: 이상'])
})

test('icons and titles follow the FMS table without exposing ids', () => {
  for (const [monitoringType, icon] of [['TH', '🌡️'], ['HVAC', '❄️'], ['UPS', '🔋'], ['DPM', '⚡'], ['LEAK', '💧'], ['FIRE', '🔥'], ['ACCESS', '🚪']]) {
    assert.equal(facilityPinIcon({ category: 'SENSOR', monitoringType }), icon)
  }
  assert.equal(facilityPinIcon({ category: 'CCTV', monitoringType: 'NVR' }), '📹')
  assert.equal(facilityPinIcon({ category: 'X', monitoringType: null }), '📍')
  assert.equal(facilityPinTitle('이름', 'C'), '이름')
  assert.equal(facilityPinTitle(null, 'C'), 'C')
  assert.equal(facilityPinTitle(null, null), '이름 없는 설비')
})

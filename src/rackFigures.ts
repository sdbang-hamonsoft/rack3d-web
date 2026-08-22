/**
 * 랙·전산실 수치 파생 로직 (UI 없음).
 *
 * **입력은 netis-fms 응답(`RackSummary`·u맵 자산)뿐이다.**
 * 랙 점유 U·여유 U 같은 집계는 `RackSummary`(FMS가 이미 계산해 준 값)에서만 낸다 —
 * 같은 수치를 u맵에서 다시 계산하면 두 소스가 갈릴 때 한 화면에 다른 숫자가 뜬다.
 * u맵 자산은 **FMS 집계로 낼 수 없는 것**(연속 빈 구간·U별 배치)에만 쓴다.
 *
 * 값이 없으면 **0이 아니라 null**을 돌려준다(C6) — 관제 화면에서 가짜 0은 사고다.
 * 순수 함수만 두어 UI 없이 검증할 수 있게 분리했다.
 */

import * as THREE from 'three'
import type { RackData, ServerData } from './rackLayouts'
import type { RackSeverity, RackSummary } from './api/types'

/** 값이 없을 때 화면에 쓰는 표기. **null을 0으로 바꾸지 않는다**(C6). */
export const NO_VALUE = '—'

export type HeatmapMode = 'normal' | 'temperature' | 'power' | 'traffic' | 'occupancy' | 'incidents'
export type ActiveHeatmapMode = Exclude<HeatmapMode, 'normal'>

export type RackHeatmapVisual = {
  mode: ActiveHeatmapMode
  /** **센서가 없으면 null.** 0으로 치환하면 32℃ 랙이 가장 차가운 색으로 칠해진다(C6). */
  value: number | null
  displayValue: string
  color: string
  /** 값이 없는 랙은 색칠·발광에서 제외한다. */
  normalized: number | null
}

export type HeatmapDataset = {
  visuals: Map<string, RackHeatmapVisual>
  /** 값이 있는 랙이 하나도 없으면 null — 범례가 `—`를 표시한다. */
  min: number | null
  max: number | null
}

export type HeatmapModeMeta = {
  label: string
  shortLabel: string
  description: string
  symbol: string
  /** false = netis-fms에 소스가 없어 지금은 켤 수 없는 모드. */
  available: boolean
}

/**
 * 히트맵 지표. **소스는 전부 netis-fms 랙 집계(E19 B1)**다.
 * traffic·incidents는 IT 장비 텔레메트리가 필요한데 FMS가 수집하지 않는다(A6 = b 확정)
 * → 켤 수 없는 모드로 두고 "미연동"을 표시한다. 가짜 0으로 채우지 않는다.
 */
export const heatmapModeMeta: Record<HeatmapMode, HeatmapModeMeta> = {
  normal: { label: 'NORMAL VIEW', shortLabel: 'NORMAL', description: '기본 보기', symbol: '◇', available: true },
  temperature: { label: 'TEMPERATURE', shortLabel: 'TEMP', description: '랙 TH 센서 온도 (FMS)', symbol: 'T', available: true },
  power: { label: 'POWER DRAW', shortLabel: 'POWER', description: '랙 DPM 전력 합 (FMS)', symbol: 'P', available: true },
  traffic: { label: 'NETWORK TRAFFIC', shortLabel: 'TRAFFIC', description: '장비 트래픽 — FMS 미수집', symbol: 'N', available: false },
  occupancy: { label: 'U OCCUPANCY', shortLabel: 'CAPACITY', description: '랙 U 점유율 (FMS)', symbol: 'U', available: true },
  // u맵이 붙어 장비 목록은 생겼지만 **장비 단위 장애 소스는 여전히 없다**(FMS 티켓 미연동 +
  // IT 장비 텔레메트리 미수집). 목록이 생겼다고 "장애 0건"으로 켜면 가짜 정상이 된다.
  incidents: { label: 'INCIDENT DENSITY', shortLabel: 'ALERTS', description: '장비 단위 장애 — FMS 티켓 미연동', symbol: '!', available: false },
}

export const heatmapModes = Object.keys(heatmapModeMeta) as HeatmapMode[]

/** 랙 U 점유율(%) — FMS 집계에서만 파생한다. 크기 미설정이면 분모가 없어 null. */
export function rackOccupancyPercent(facts: RackSummary | null | undefined): number | null {
  if (!facts || !facts.rackUnits) return null
  return Math.min(100, facts.occupiedUnits / facts.rackUnits * 100)
}

/** 랙 여유 U — FMS 집계에서만 파생. 크기 미설정이면 null. */
export function rackAvailableUnits(facts: RackSummary | null | undefined): number | null {
  if (!facts || !facts.rackUnits) return null
  return Math.max(0, facts.rackUnits - facts.occupiedUnits)
}

/**
 * 히트맵 값. 소스는 netis-fms 랙 집계다.
 * **센서가 없는 랙은 null을 돌려준다** — 0을 돌려주면 그 랙이 "가장 차가운/가장 낮은" 랙으로
 * 칠해져 실제 32℃인 랙과 구분되지 않는다(C6).
 */
function getRackHeatmapValue(facts: RackSummary | undefined, mode: ActiveHeatmapMode): number | null {
  if (!facts) return null
  if (mode === 'temperature') return facts.temp
  if (mode === 'power') return facts.powerKw
  if (mode === 'occupancy') return rackOccupancyPercent(facts)
  // traffic·incidents — FMS에 소스가 없다(heatmapModeMeta.available = false).
  return null
}

export function formatHeatmapValue(mode: ActiveHeatmapMode, value: number | null) {
  if (value === null) return NO_VALUE
  if (mode === 'temperature') return `${value.toFixed(1)}°C`
  if (mode === 'power') return `${value.toFixed(2)} kW`
  if (mode === 'traffic') return `${value.toFixed(0)} Mbps`
  return `${value.toFixed(1)}%`
}

/**
 * ZONE 단위 집계 — **전부 FMS 랙 목록(RackSummary)에서만 파생한다.**
 * 랙 내부 장비(u맵)가 없어도 알 수 있는 것만 담는다.
 */
export type ZoneAggregate = {
  rackCount: number
  /**
   * `RackSummary.assetCount` 합 = **U가 배정된 활성 자산 수**(FMS `WHERE rack_start_u IS NOT NULL`).
   * u맵 `assets[]`와 같은 모집단이다. §11-11 Q1에서 FMS가 확정한 정의.
   */
  mountedAssetCount: number
  /**
   * `RackSummary.categoryCounts` 합 = **랙 내 전체 활성 자산 수**(U 무관).
   * 문짝 온습도센서·PDU처럼 U 슬롯을 안 먹는 자산이 여기만 잡힌다 —
   * 그래서 {@link mountedAssetCount}보다 크거나 같다. **두 수는 정의가 다르므로
   * 화면에서 라벨을 반드시 나눈다**(랙 17: 장착 4 / 랙 내 5).
   */
  rackAssetCount: number
  /** 카테고리별 랙 내 자산 수 합(SERVER·SENSOR 등). FMS `assets.category` 원값이 키다. */
  categoryTotals: Record<string, number>
  /** 크기(rackUnits)가 설정된 랙만 합산. 하나도 없으면 null. */
  totalUnits: number | null
  occupiedUnits: number | null
  availableUnits: number | null
  occupancyPercent: number | null
  /** 크기 미설정 랙이 섞여 있으면 true — 합계가 전체 랙을 대표하지 않는다. */
  unitsPartial: boolean
  /** U 합계에 실제로 기여한 랙 수(크기가 설정된 랙). 캡션이 집계 범위를 과장하지 않게 쓴다. */
  sizedRackCount: number
  /** FMS 판정이 NORMAL이 아닌 랙 수. 장비 단위가 아니라 **랙 단위**다. */
  alertRackCount: number
  criticalRackCount: number
  staleRackCount: number
}

export function aggregateZoneRacks(zoneRacks: RackSummary[] | null): ZoneAggregate | null {
  if (!zoneRacks) return null
  let totalUnits = 0
  let occupiedUnits = 0
  let sizedRacks = 0
  let mountedAssetCount = 0
  let rackAssetCount = 0
  const categoryTotals: Record<string, number> = {}
  let alertRackCount = 0
  let criticalRackCount = 0
  let staleRackCount = 0

  zoneRacks.forEach((rack) => {
    mountedAssetCount += rack.assetCount
    Object.entries(rack.categoryCounts ?? {}).forEach(([category, count]) => {
      rackAssetCount += count
      categoryTotals[category] = (categoryTotals[category] ?? 0) + count
    })
    if (rack.rackUnits) {
      sizedRacks += 1
      totalUnits += rack.rackUnits
      occupiedUnits += rack.occupiedUnits
    }
    if (rack.severity !== 'NORMAL') alertRackCount += 1
    if (rack.severity === 'CRITICAL') criticalRackCount += 1
    if (rack.stale) staleRackCount += 1
  })

  const sized = sizedRacks > 0
  return {
    rackCount: zoneRacks.length,
    mountedAssetCount,
    rackAssetCount,
    categoryTotals,
    totalUnits: sized ? totalUnits : null,
    occupiedUnits: sized ? occupiedUnits : null,
    availableUnits: sized ? totalUnits - occupiedUnits : null,
    occupancyPercent: sized && totalUnits > 0 ? occupiedUnits / totalUnits * 100 : null,
    unitsPartial: sizedRacks !== zoneRacks.length,
    sizedRackCount: sizedRacks,
    alertRackCount,
    criticalRackCount,
    staleRackCount,
  }
}

/** 값이 없는 랙에 쓰는 중립색 — 히트맵 색계(파랑→빨강) 어디에도 속하지 않게 회색을 쓴다. */
const HEATMAP_NO_VALUE_COLOR = '#566174'

/**
 * 색 정규화 구간. **값이 있는 랙만으로** 계산한다(null 랙이 최솟값을 0으로 끌어내리지 않게).
 * 랙 간 편차가 아주 작을 때 미세한 차이가 전 색상 스펙트럼으로 과장되지 않도록 최소 폭을 둔다.
 */
export function getHeatmapRange(mode: ActiveHeatmapMode, values: number[]): { min: number | null; max: number | null } {
  if (values.length === 0) return { min: null, max: null }
  if (mode === 'occupancy') return { min: 0, max: 100 }
  const low = Math.min(...values)
  const high = Math.max(...values)
  const minimumSpan = mode === 'temperature' ? 4 : 0.5 // ℃ / kW
  if (high - low >= minimumSpan) return { min: low, max: high }
  const middle = (low + high) / 2
  let min = middle - minimumSpan / 2
  let max = middle + minimumSpan / 2
  // 전력은 음수가 될 수 없다 — 저부하 랙만 있을 때 대칭 확장이 `-0.13 kW` 같은 범례를 만든다.
  // 하한을 0으로 막고 부족분을 상한에 얹어 최소 폭은 유지한다.
  if (mode === 'power' && min < 0) {
    max -= min
    min = 0
  }
  return { min, max }
}

function getHeatmapColor(normalized: number) {
  const low = new THREE.Color('#2498ff')
  const middle = new THREE.Color('#ffd34d')
  const high = new THREE.Color('#ff365c')
  const color = normalized <= 0.5
    ? low.lerp(middle, normalized * 2)
    : middle.lerp(high, (normalized - 0.5) * 2)
  return `#${color.getHexString()}`
}

export function getHeatmapDataset(
  rackData: RackData[],
  mode: HeatmapMode,
  factsById: Map<string, RackSummary>,
): HeatmapDataset {
  if (mode === 'normal' || !heatmapModeMeta[mode].available) return { visuals: new Map(), min: null, max: null }

  const values = rackData.map((rack) => ({ rack, value: getRackHeatmapValue(factsById.get(rack.id), mode) }))
  const known = values.map(({ value }) => value).filter((value): value is number => value !== null)
  const { min, max } = getHeatmapRange(mode, known)
  const spread = min !== null && max !== null ? max - min : 0
  const visuals = new Map<string, RackHeatmapVisual>()

  values.forEach(({ rack, value }) => {
    if (value === null || min === null) {
      // 센서 없음 — 중립색 + `—` 뱃지. 색·발광은 걸지 않는다(정상값과 섞이면 안 된다).
      visuals.set(rack.id, {
        mode,
        value: null,
        displayValue: NO_VALUE,
        color: HEATMAP_NO_VALUE_COLOR,
        normalized: null,
      })
      return
    }
    const normalized = spread > 0 ? THREE.MathUtils.clamp((value - min) / spread, 0, 1) : 0.5
    visuals.set(rack.id, {
      mode,
      value,
      displayValue: formatHeatmapValue(mode, value),
      color: getHeatmapColor(normalized),
      normalized,
    })
  })

  return { visuals, min, max }
}


// ── 랙 U 배치(u맵) 파생 ──────────────────────────────────────────────────────

export type FreeUnitBlock = {
  startU: number
  units: number
}

/**
 * 랙의 빈 U 구간. **랙 크기(`rackUnits`)를 모르면 null** — 42U를 가정하는 순간
 * 20U 랙에 "22U 여유"가 뜬다(C6, 백로그 ⚠️ 항목).
 *
 * 위 U부터 정렬해 돌려준다(랙 도면과 같은 순서).
 */
export function getFreeUnitBlocks(servers: ServerData[], rackUnits: number | null): FreeUnitBlock[] | null {
  if (!rackUnits || rackUnits <= 0) return null
  const occupied = new Set<number>()
  servers.forEach((server) => {
    for (let unit = server.startU; unit < server.startU + server.units; unit += 1) occupied.add(unit)
  })

  const blocks: FreeUnitBlock[] = []
  let startU: number | null = null
  for (let unit = 1; unit <= rackUnits + 1; unit += 1) {
    const isFree = unit <= rackUnits && !occupied.has(unit)
    if (isFree && startU === null) startU = unit
    if (!isFree && startU !== null) {
      blocks.push({ startU, units: unit - startU })
      startU = null
    }
  }
  return blocks.sort((a, b) => b.startU - a.startU)
}

/** 가장 긴 연속 빈 구간(U). 크기 미설정이면 null. */
export function largestFreeBlock(servers: ServerData[], rackUnits: number | null): number | null {
  const blocks = getFreeUnitBlocks(servers, rackUnits)
  if (blocks === null) return null
  return blocks.reduce((longest, block) => Math.max(longest, block.units), 0)
}

// ── FMS 판정 등급 → 화면 톤 ──────────────────────────────────────────────────

/** FMS 등급 3단계 → 화면 2단계. E19 C1 합의(CRITICAL→CRITICAL, MAJOR·CAUTION→WARNING). */
export type SeverityTone = 'normal' | 'warning' | 'critical'

export const severityTones: Record<RackSeverity, SeverityTone> = {
  NORMAL: 'normal',
  CAUTION: 'warning',
  MAJOR: 'warning',
  CRITICAL: 'critical',
}

/** 랙 경보 3D 표시·범례가 함께 쓰는 색. 한 화면에서 색과 범례가 어긋나지 않게 한 곳에 둔다. */
export const severityToneColors: Record<SeverityTone, string> = {
  normal: '#21e878',
  warning: '#ffc247',
  critical: '#ff3c56',
}

/**
 * "랙 내 자산"(categoryCounts 합) **표시값**.
 *
 * `categoryCounts`가 비어 있으면 합이 0이 되는데, 그건 "자산 0대"가 아니라 **필드 부재**일 수
 * 있다. 장착 수(U 배정)보다 작게 나오는 순간 그 값은 집계로서 성립하지 않으므로(랙 내 자산은
 * 정의상 장착 자산의 상위집합이다) 0을 그리지 않고 null을 돌려준다 — 가짜 0도, `-4대` 같은
 * 음수 차이도 만들지 않는다(C6).
 */
export function displayRackAssetCount(rackAssetCount: number, mountedAssetCount: number): number | null {
  return rackAssetCount >= mountedAssetCount ? rackAssetCount : null
}

/** U 미배정 자산 수. 두 수가 성립할 때만, 그리고 0보다 클 때만 값이 나온다. */
export function unmountedAssetCount(rackAssetCount: number | null, mountedAssetCount: number): number | null {
  if (rackAssetCount === null) return null
  const difference = rackAssetCount - mountedAssetCount
  return difference > 0 ? difference : null
}

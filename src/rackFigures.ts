/**
 * 랙·전산실 수치 파생 로직 (UI 없음).
 *
 * **여기 있는 함수는 netis-fms 랙 집계(`RackSummary`)만 입력으로 받는다.**
 * 로컬 3D 배치(`RackData`)는 식별자·라벨 용도로만 쓰고 수치를 만들지 않는다 —
 * 랙 내부 장비(u맵)가 아직 연동되지 않아 `servers`가 비어 있어서, 거기서 수치를 파생하면
 * "OCCUPIED 20U · AVAILABLE 42U" 같은 모순이 생긴다.
 *
 * 값이 없으면 **0이 아니라 null**을 돌려준다(C6) — 관제 화면에서 가짜 0은 사고다.
 * 순수 함수만 두어 UI 없이 검증할 수 있게 분리했다.
 */

import * as THREE from 'three'
import type { RackData } from './rackLayouts'
import type { RackSummary } from './api/types'

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
  incidents: { label: 'INCIDENT DENSITY', shortLabel: 'ALERTS', description: '장비 단위 장애 — U맵 미연동', symbol: '!', available: false },
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
  assetCount: number
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
  let assetCount = 0
  let alertRackCount = 0
  let criticalRackCount = 0
  let staleRackCount = 0

  zoneRacks.forEach((rack) => {
    assetCount += rack.assetCount
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
    assetCount,
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


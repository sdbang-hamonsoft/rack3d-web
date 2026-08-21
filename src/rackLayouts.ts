import type { RackSummary } from './api/types'

export type ServerStatus = 'healthy' | 'warning' | 'critical' | 'offline'
export type ServerModel = 'dell-poweredge-r760' | 'hpe-proliant-dl360-gen11' | 'cisco-ucs-c240-m7'

export type ServerData = {
  id: string
  name: string
  model: ServerModel
  startU: number
  units: 1 | 2
  status: ServerStatus
}

export type RackData = {
  id: string
  label: string
  /**
   * 3D 지오메트리를 그리기 위한 U 수. FMS `rackUnits`가 미설정이면
   * {@link DEFAULT_RACK_UNITS}로 **대체된 값**이다 — 사용자에게 숫자로 보여주면 안 된다.
   * 표시에는 반드시 {@link RackData.rackUnits}(FMS 원값)를 쓰고 null이면 `—`로 둘 것(C6).
   */
  totalUnits: number
  /** FMS `locations.rack_units` 원값. null = 크기 미설정. **표시 전용 SSOT.** */
  rackUnits: number | null
  tileX: number
  tileZ: number
  rotation: number
  servers: ServerData[]
}

export const GRID_COLUMNS = 18
export const GRID_ROWS = 14
export const LAYOUT_STORAGE_VERSION = 1

/**
 * 저장되는 랙 1건 — **좌표만 담는다.**
 *
 * 예전 포맷은 label·totalUnits·servers도 함께 기록했다. 그런데 그 값들은 전부
 * netis-fms가 SSOT이고(D1) 읽을 때 무시된다. 특히 `totalUnits`는 크기 미설정 랙에
 * 폴백 42가 들어가 **"지어낸 값이 파일에 남는" 유일한 경로**였다 —
 * 지금은 표시되지 않지만 E18 연동 때 이 파일을 신뢰하는 코드가 생기면 그대로 사고가 된다.
 * 애초에 기록하지 않는다.
 *
 * 구버전 파일도 그대로 읽힌다(읽는 필드가 부분집합이라 남는 키는 무시된다).
 */
export type StoredRack = {
  id: string
  gridX: number
  gridZ: number
  rotationDegrees: number
}

export type StoredRackLayout = {
  version: number
  updatedAt: string
  racks: StoredRack[]
}

const layoutStorageKey = (dataCenterId: string) => `rack3d-layout:${dataCenterId}`

export function normalizeDegrees(degrees: number) {
  return ((Math.round(degrees) % 360) + 360) % 360
}

export function degreesToRadians(degrees: number) {
  return normalizeDegrees(degrees) * Math.PI / 180
}

export function radiansToDegrees(radians: number) {
  return normalizeDegrees(radians / Math.PI * 180)
}

// ── netis-fms 랙 목록 → 3D 씬 랙 (S1) ───────────────────────────────────────
//
// 랙의 **존재·이름·크기는 netis-fms가 SSOT**다(D1). rack3d가 로컬에 보관하는 것은
// 3D 배치 좌표뿐이며, 이것도 FMS E18(zone layout) 완료 시 대체된다(S4).

/** FMS `rackUnits`가 NULL(크기 미설정)일 때 3D 지오메트리에만 쓰는 기본 U 수. */
export const DEFAULT_RACK_UNITS = 42

/** 씬/배치 저장에서 랙을 식별하는 키 — FMS `locations.id`에 고정한다. */
export function rackElementId(locationId: number): string {
  return `fms-rack-${locationId}`
}

export type RackPlacement = {
  gridX: number
  gridZ: number
  rotationDegrees: number
}

/**
 * 저장된 배치에서 **좌표만** 읽는다.
 *
 * 저장 파일에는 라벨·서버 목록도 함께 들어 있지만(구 포맷 호환) 그것들은 읽지 않는다 —
 * FMS가 SSOT인 값을 로컬 사본으로 되살리면 실제와 어긋난 옛 데이터가 화면에 남는다.
 */
export function loadRackPlacements(dataCenterId: string): Map<string, RackPlacement> {
  const placements = new Map<string, RackPlacement>()
  try {
    const raw = window.localStorage.getItem(layoutStorageKey(dataCenterId))
    if (!raw) return placements
    const parsed = JSON.parse(raw) as StoredRackLayout
    if (parsed?.version !== LAYOUT_STORAGE_VERSION || !Array.isArray(parsed.racks)) return placements
    parsed.racks.forEach((rack) => {
      if (typeof rack?.id !== 'string') return
      placements.set(rack.id, {
        gridX: rack.gridX,
        gridZ: rack.gridZ,
        rotationDegrees: rack.rotationDegrees,
      })
    })
  } catch {
    // 저장값이 깨졌으면 배치 없음으로 본다 — 아래 자동 배치가 채운다.
  }
  return placements
}

/** 이미 점유된 타일을 피해 빈 타일을 순서대로 내주는 커서. */
function createTileAllocator(occupied: Set<string>) {
  let cursor = 0
  return (): { tileX: number; tileZ: number } => {
    while (cursor < GRID_COLUMNS * GRID_ROWS) {
      const tileX = cursor % GRID_COLUMNS
      const tileZ = Math.floor(cursor / GRID_COLUMNS)
      cursor += 1
      if (!occupied.has(`${tileX}:${tileZ}`)) {
        occupied.add(`${tileX}:${tileZ}`)
        return { tileX, tileZ }
      }
    }
    // 그리드가 꽉 찬 경우 — 겹쳐서라도 놓는다(관제 화면에서 랙이 사라지는 편이 더 나쁘다).
    return { tileX: 0, tileZ: 0 }
  }
}

/**
 * FMS 랙 목록 + 저장된 배치 → 3D 씬 랙 목록.
 * 배치가 없는 랙(신규 등록 등)은 빈 타일에 자동 배치한다.
 */
export function buildRacksFromZone(
  zoneRacks: RackSummary[],
  placements: Map<string, RackPlacement>,
): RackData[] {
  const occupied = new Set<string>()
  zoneRacks.forEach((rack) => {
    const placement = placements.get(rackElementId(rack.locationId))
    if (placement) occupied.add(`${placement.gridX}:${placement.gridZ}`)
  })
  const allocate = createTileAllocator(occupied)

  return zoneRacks.map((rack) => {
    const id = rackElementId(rack.locationId)
    const placement = placements.get(id)
    const tile = placement
      ? { tileX: placement.gridX, tileZ: placement.gridZ }
      : allocate()
    return {
      id,
      label: rack.name,
      totalUnits: rack.rackUnits ?? DEFAULT_RACK_UNITS, // 지오메트리 전용 폴백
      rackUnits: rack.rackUnits,                          // 표시용 원값(미설정이면 null)
      tileX: tile.tileX,
      tileZ: tile.tileZ,
      rotation: degreesToRadians(placement?.rotationDegrees ?? 0),
      // S1 범위에서는 랙 내부 장비(U맵)를 가져오지 않는다.
      // 다음 단계에서 `GET /api/racks/{id}/u-map`으로 채운다 — 임의 값으로 채우지 않는다.
      servers: [],
    }
  })
}

/** 저장된 배치를 무시하고 전부 빈 타일에 순서대로 다시 놓는다(에디터의 "자동 배치"). */
export function autoArrangeRacks(racks: RackData[]): RackData[] {
  const allocate = createTileAllocator(new Set<string>())
  return racks.map((rack) => ({ ...rack, ...allocate(), rotation: 0 }))
}

export function cloneRackList(racks: RackData[]): RackData[] {
  return racks.map((rack) => ({ ...rack, servers: rack.servers.map((server) => ({ ...server })) }))
}

export function saveRacksForDataCenter(dataCenterId: string, racks: RackData[]): boolean {
  const payload: StoredRackLayout = {
    version: LAYOUT_STORAGE_VERSION,
    updatedAt: new Date().toISOString(),
    racks: racks.map((rack) => ({
      id: rack.id,
      gridX: rack.tileX,
      gridZ: rack.tileZ,
      rotationDegrees: radiansToDegrees(rack.rotation),
    })),
  }
  try {
    window.localStorage.setItem(layoutStorageKey(dataCenterId), JSON.stringify(payload))
    return true
  } catch {
    // 쿼터 초과나 프라이빗 모드 등으로 영속화에 실패한 경우 — 호출부가 사용자에게 알린다.
    return false
  }
}

import type { RackAsset, RackSummary, RackUMap } from './api/types'

/** 번들에 들어 있는 3D 장비 모델 3종. **형상 근사용이며 표시 문구의 출처가 아니다.** */
export type ServerModel = 'dell-poweredge-r760' | 'hpe-proliant-dl360-gen11' | 'cisco-ucs-c240-m7'

/** 각 GLB의 고유 높이(U). 실측(`public/models/*.glb` POSITION accessor min/max). */
export const SERVER_MODEL_UNITS: Record<ServerModel, number> = {
  'dell-poweredge-r760': 2,
  'hpe-proliant-dl360-gen11': 1,
  'cisco-ucs-c240-m7': 2,
}

/**
 * 3D 씬이 그리는 랙 내부 장비 1건 — **netis-fms u맵 자산(`RackAsset`)의 씬 표현**이다.
 *
 * ⚠️ **장비 상태 필드는 없다.** 예전 `status: 'healthy'|'warning'|...`는 시드 데이터였고,
 * netis-fms는 IT 장비 텔레메트리를 수집하지 않아 대체 소스가 **영구히 없다**(A6 = b).
 * `lifecycleStatus`(자산 원장의 생애주기)를 건강 상태로 환산하지 않는다 — 그건 지어내기다(C6).
 *
 * `model`은 형상 근사치다. **화면에 글자로 나가는 제조사·모델명은 반드시 FMS 원값**
 * (`manufacturer`/`modelName`)을 쓰고, 없으면 `—`로 둔다.
 */
export type ServerData = {
  /** 씬 식별자 — FMS `assets.id` 고정(`fms-asset-<id>`). */
  id: string
  /** FMS `assets.id` 원값. */
  assetId: number
  assetCode: string
  name: string
  category: string | null
  monitoringType: string | null
  manufacturer: string | null
  modelName: string | null
  serialNo: string | null
  spec: string | null
  ip: string | null
  lifecycleStatus: string | null
  startU: number
  /** 높이(U) = `rackEndU - rackStartU + 1`. 1·2U 고정이 아니다(실데이터에 4U 자산이 있다). */
  units: number
  hasFront: boolean
  hasRear: boolean
  /** 형상 근사용 GLB. 표시 문구로 쓰지 말 것. */
  model: ServerModel
}

export type RackData = {
  id: string
  label: string
  /**
   * FMS `locations.rack_units` 원값. null = 크기 미설정.
   *
   * ⚠️ 예전에는 이 옆에 "지오메트리 전용 폴백" `totalUnits`(미설정 시 42)가 함께 있었는데,
   * **읽는 곳이 하나도 없는 write-only 필드**가 되어 제거했다. 폴백 42가 필드로 남아 있으면
   * 다음 사람이 다시 읽어 화면에 흘린다 — 그게 정확히 백로그에 올라 있던 사고 경로다(C6).
   * 3D 랙 GLB는 지금도 42U 형상 하나뿐이지만 그건 **형상**이지 수치가 아니다.
   */
  rackUnits: number | null
  tileX: number
  tileZ: number
  rotation: number
  servers: ServerData[]
  /**
   * u맵 응답을 **받았는가**. false면 "장비 0대"가 아니라 **모르는 상태**다 —
   * 빈 목록을 "장착 장비 없음"으로 표시하면 가짜 0과 같은 사고가 된다(C6).
   */
  uMapKnown: boolean
}

// ── u맵 자산 → 씬 장비 ───────────────────────────────────────────────────────

/** 씬/검색에서 자산을 식별하는 키 — FMS `assets.id`에 고정한다. */
export function assetElementId(assetId: number): string {
  return `fms-asset-${assetId}`
}

/** 제조사 문자열에서 우리 GLB 3종을 찾는다. 못 찾으면 null(지어내지 않는다). */
function modelForManufacturer(manufacturer: string | null): ServerModel | null {
  const name = (manufacturer ?? '').toLowerCase()
  if (!name) return null
  if (name.includes('dell')) return 'dell-poweredge-r760'
  if (name.includes('hpe') || name.includes('hewlett')) return 'hpe-proliant-dl360-gen11'
  if (name.includes('cisco')) return 'cisco-ucs-c240-m7'
  return null
}

/**
 * 자산 → 3D 형상 GLB 선택.
 *
 * 우리 GLB는 dell(2U)·hpe(1U)·cisco(2U) 3종뿐인데 FMS 자산은 제조사가 임의(Synology 등)이거나
 * null이다. **형상은 근사치여도 되지만 글자는 실제 값이어야 한다**는 원칙에 따라:
 * 1. 제조사가 3사 중 하나면 그 브랜드 GLB (관제자가 랙을 보고 브랜드를 알아보는 값이 크다)
 * 2. 아니면 U 높이로 고른다 — 1U는 hpe(1U 모델), 2U 이상은 dell(2U 모델)
 *
 * 어느 경로든 {@link ServerData.units}만큼 Y축을 늘려 **실제 점유 높이는 정확히 맞춘다**
 * (형상은 근사여도 "몇 U를 먹는가"는 실데이터라 틀리면 안 된다).
 */
export function pickServerModel(manufacturer: string | null, units: number): ServerModel {
  return modelForManufacturer(manufacturer)
    ?? (units <= 1 ? 'hpe-proliant-dl360-gen11' : 'dell-poweredge-r760')
}

/**
 * u맵 자산 1건 → 씬 장비. U 범위가 성립하지 않으면 null(그 자산은 씬에서 뺀다).
 * FMS가 U 배정 자산만 준다는 계약이지만, **믿고 렌더해서 좌표가 깨지는 것보다 빼는 게 낫다**(C5).
 */
export function toServerData(asset: RackAsset): ServerData | null {
  const startU = asset.rackStartU
  const endU = asset.rackEndU
  if (!Number.isInteger(startU) || !Number.isInteger(endU)) return null
  if (startU < 1 || endU < startU) return null
  const units = endU - startU + 1
  return {
    id: assetElementId(asset.id),
    assetId: asset.id,
    assetCode: asset.assetCode,
    name: asset.name,
    category: asset.category,
    monitoringType: asset.monitoringType,
    manufacturer: asset.manufacturer,
    modelName: asset.modelName,
    serialNo: asset.serialNo,
    spec: asset.spec,
    ip: asset.ip,
    lifecycleStatus: asset.lifecycleStatus,
    startU,
    units,
    hasFront: asset.hasFront,
    hasRear: asset.hasRear,
    model: pickServerModel(asset.manufacturer, units),
  }
}

/** u맵 응답 → 씬 장비 목록(위 U부터 정렬 — 랙 도면과 같은 순서). */
export function toServerList(uMap: RackUMap): ServerData[] {
  return uMap.assets
    .map(toServerData)
    .filter((server): server is ServerData => server !== null)
    .sort((a, b) => b.startU - a.startU)
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
 * FMS 랙 목록 + 저장된 배치 + ZONE u맵 → 3D 씬 랙 목록.
 * 배치가 없는 랙(신규 등록 등)은 빈 타일에 자동 배치한다.
 *
 * @param uMaps `GET /api/zones/{id}/u-maps` 응답. `null`이면 아직 못 받은 것이다.
 *
 * **페어링은 순서가 아니라 `locationId` 값으로 한다.** FMS가 두 응답의 순서 일치를 계약으로
 * 보장하고 실측도 맞지만(`racks [17,16]` == `u-maps [17,16]`), 서로 다른 엔드포인트 사이의
 * 순서 결합은 깨지기 쉽고 깨져도 조용하다 — 값으로 맞추면 계약이 흔들려도 안전하다.
 *
 * 응답에 없는 랙은 `uMapKnown: false`가 된다. **"장비 0대"가 아니라 "모름"이다**(C6) —
 * 빈 배열로 채우면 화면이 "장착 장비 없음"이라고 단언한다.
 */
export function buildRacksFromZone(
  zoneRacks: RackSummary[],
  placements: Map<string, RackPlacement>,
  uMaps: RackUMap[] | null,
): RackData[] {
  const uMapByLocationId = new Map<number, RackUMap>()
  uMaps?.forEach((uMap) => uMapByLocationId.set(uMap.rack.locationId, uMap))

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
    const uMap = uMapByLocationId.get(rack.locationId)
    return {
      id,
      label: rack.name,
      rackUnits: rack.rackUnits, // FMS 원값(미설정이면 null) — 지어낸 폴백을 두지 않는다
      tileX: tile.tileX,
      tileZ: tile.tileZ,
      rotation: degreesToRadians(placement?.rotationDegrees ?? 0),
      servers: uMap ? toServerList(uMap) : [],
      uMapKnown: uMap !== undefined,
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

// ── 씬 랙 객체 신원 유지 ─────────────────────────────────────────────────────

export type RackCacheEntry = {
  signature: string
  rack: RackData
}

/**
 * **값이 그대로면 이전 객체를 그대로 돌려준다.**
 *
 * 랙 목록 폴링(30초)과 u맵 스윕(랙 1건마다)이 각각 새 배열을 만들기 때문에, 그대로 두면
 * `RackData` 객체가 초당 두 번씩 새 신원을 갖는다. 그러면 `focusRack`을 의존성으로 쓰는
 * effect가 계속 재실행된다 — 실제로 **카메라 전이(0.85초)가 매번 리셋되어 스윕이 도는 동안
 * 마우스·키보드 조작이 통째로 먹히지 않는 버그**가 났다.
 *
 * 신원을 값에 묶어 두면 "값이 바뀐 랙만 새 객체"가 되어, 그 종류의 버그가 구조적으로 안 생긴다.
 */
export function reuseUnchangedRacks(
  cache: Map<string, RackCacheEntry>,
  built: RackData[],
): { racks: RackData[]; cache: Map<string, RackCacheEntry> } {
  const next = new Map<string, RackCacheEntry>()
  const racks = built.map((rack) => {
    // 필드가 늘어도 자동으로 따라오도록 통째로 직렬화한다(랙 수십 대 규모라 비용이 무시할 만하다).
    const signature = JSON.stringify(rack)
    const previous = cache.get(rack.id)
    const stable = previous && previous.signature === signature ? previous.rack : rack
    next.set(rack.id, { signature, rack: stable })
    return stable
  })
  return { racks, cache: next }
}

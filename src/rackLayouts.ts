import type {
  LayoutDirection,
  LayoutObject,
  RackAsset,
  RackSummary,
  RackUMap,
  ZoneLayout,
} from './api/types'

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
  /**
   * netis-fms ZONE 배치도의 좌표·방위(E18).
   *
   * **`null` = 이 랙이 FMS 레이아웃에 배치되어 있지 않다.** 그때는 3D 에 그리지 않는다 —
   * 임의 위치에 놓으면 실제 배치로 오인된다. 다만 랙 자체를 목록·검색·경보에서 빼지는
   * 않는다(경보 중인 랙이 화면에서 사라지는 것이 더 나쁘다). 호출부가 "미배치 N대"를 밝힌다.
   */
  placement: ScenePlacement | null
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

// ── netis-fms ZONE 배치(E18) → 3D 씬 ────────────────────────────────────────
//
// 3D 좌표의 SSOT 는 netis-fms `GET /api/layouts/zones/{id}/layout` 이다.
//
// ⚠️ **예전 코드가 여기 있었다**: `rack3d-layout:<zoneId>` localStorage 저장·읽기
// (`StoredRack`·`loadRackPlacements`·`saveRacksForDataCenter`)와 빈 타일 자동 배치
// (`createTileAllocator`·`autoArrangeRacks`), 그리고 `GRID_COLUMNS 18`·`GRID_ROWS 14`
// 상수. **되살리지 말 것** — 좌표 편집 지점이 두 곳이면 어느 쪽이 정답인지 흐려지고,
// 자동 배치는 "FMS 가 SSOT"라는 전제와 정면으로 모순된다(E18 ①·⑤ 확정).
// 배치가 없는 ZONE 은 **그리지 않고 안내한다**(실측 8 ZONE 중 6개가 미설정이다).

/** 씬·배치 페어링에서 랙을 식별하는 키 — FMS `locations.id`에 고정한다. */
export function rackElementId(locationId: number): string {
  return `fms-rack-${locationId}`
}

/** 1U 높이(m). 랙 프레임·장비 배치가 공유하는 물리 상수(19인치 랙 규격 44.45mm). */
export const RACK_UNIT_HEIGHT_M = 0.04445
/** 랙 바닥에서 U01 하단까지(m). 3D 랙 GLB 실측값. */
export const RACK_BASE_HEIGHT_M = 0.06655

/**
 * ZONE 배치 그리드. **값은 전부 FMS 응답에서 온다**(`grid.cols/rows/tileMm`).
 *
 * `ceilingMm`(2800·3200 실측)은 **1차에 3D 로 반영하지 않는다.** 천장 면을 그리면 이 화면의
 * 기본 시점인 부감(俯瞰)에서 씬 전체가 가려지고, 카메라 Y 상한을 천장으로 묶으면 전체 보기가
 * 불가능해진다 — 즉 지금 쓸 수 있는 반영 방법이 둘 다 화면을 나쁘게 만든다. 값 자체는 계약에
 * 남겨 두었으므로(`LayoutGrid.ceilingMm`) 나중에 실내 시점을 도입할 때 추가로 쓰면 된다.
 */
export type SceneGrid = {
  cols: number
  rows: number
  /** 타일 한 변(m) — `tileMm / 1000`. */
  tileSize: number
}

/** 배치도 위 한 칸의 좌표·방위. */
export type ScenePlacement = {
  /** 열(0-base). 오른쪽 = EAST. */
  tileX: number
  /** 행(0-base). 아래 = SOUTH. */
  tileZ: number
  /** FMS 원값 — 표시·검증용. */
  dir: LayoutDirection
  /** three.js Y축 회전(rad). {@link directionToRotation} 참조. */
  rotation: number
}

/**
 * 랙으로 페어링되지 않은 배치 오브젝트 1건 — **종류별 색 박스 + 레이블**로 그린다(E18 ④).
 *
 * 3D 모델은 확보하지 않는다("대강 구분만 되면 된다" — 제품 오너). 여기 담기는 것은
 * ① 비-RACK 12종 ② `rack` 참조가 없거나 랙 목록과 페어링되지 않은 RACK 오브젝트다.
 */
export type SceneObject = {
  /** 씬 키 — `zone_layout_object.id` 고정. 랙 위치 id 와 섞이지 않게 접두사를 붙인다. */
  id: string
  /** FMS 원값(모르는 종류도 그대로). */
  type: string
  /** 표시명 — `label` 우선, 비었으면 `type`(§11-31 ①). 지어내지 않는다. */
  label: string
  /** FMS 2D 에디터 팔레트 색. 모르는 종류는 회색. */
  color: string
  /** 박스 높이(m). RACK 만 실치수(U 수) 기반이고 나머지는 rack3d 임의값이다. */
  heightM: number
  placement: ScenePlacement
}

/** ZONE 하나의 3D 씬 입력 전부. */
export type ZoneScene = {
  /** `null` = 이 ZONE 은 netis-fms 레이아웃이 설정되지 않았다 → 3D 를 그리지 않는다(E18 ⑤). */
  grid: SceneGrid | null
  /** FMS 랙 목록(SSOT) 전량. 배치가 없는 랙은 `placement: null`이다. */
  racks: RackData[]
  /** 랙이 아닌(또는 페어링되지 않은) 배치 오브젝트. */
  objects: SceneObject[]
}

/**
 * FMS 2D 레이아웃 에디터 팔레트(§11-31 ①). **2D 와 3D 색이 같아야** 사용자가 대응을 바로 읽는다.
 *
 * 여기 없는 종류는 {@link UNKNOWN_OBJECT_COLOR} 회색으로 흘려보낸다 — FMS 가 나중에 type 을
 * 늘려도 rack3d 가 깨지면 안 된다.
 */
export const LAYOUT_OBJECT_COLORS: Record<string, string> = {
  RACK: '#1E5083',
  CRAC: '#00796B',
  UPS: '#7B1FA2',
  POWER: '#C2185B',
  FIRE: '#D32F2F',
  WATER: '#0288D1',
  SENSOR: '#E65100',
  CCTV: '#388E3C',
  DOOR: '#4E342E',
  GATE: '#616161',
  GAS: '#F57C00',
  SEISMIC: '#512DA8',
}

/** 모르는 종류의 색. 팔레트 12종과 겹치지 않는 중립 회색이어야 한다. */
export const UNKNOWN_OBJECT_COLOR = '#6E7B8A'

/**
 * 비-RACK 오브젝트의 박스 높이(m) — **rack3d 가 임의로 정한 값이다.**
 *
 * FMS 는 오브젝트의 물리 폭·깊이·높이를 **관리하지 않는다**(§11-31 ②: `zone_layout_object` 에
 * width/depth 컬럼 없음). 그래서 이 수치는 측정값이 아니라 "대강 구분"을 위한 표현이고,
 * **화면에 숫자로 내보내지 않는다**(형상은 근사여도 되지만 글자는 실값이어야 한다는 규칙).
 * 실물 대략치를 참고해 정했다: 바닥 설치형(CRAC·배전반·방화문)은 사람 키 이상, 감지기·센서류는
 * 낮게 두어 랙 사이에서 시야를 가리지 않게 한다.
 */
export const LAYOUT_OBJECT_HEIGHTS_M: Record<string, number> = {
  CRAC: 2.0,
  UPS: 1.6,
  POWER: 1.8,
  FIRE: 0.3,
  WATER: 0.2,
  SENSOR: 0.3,
  CCTV: 0.35,
  DOOR: 2.1,
  GATE: 1.2,
  GAS: 0.3,
  SEISMIC: 0.3,
}

/** 모르는 종류의 박스 높이(m). */
export const UNKNOWN_OBJECT_HEIGHT_M = 0.6

/** 크기(U)를 모르는 RACK 오브젝트의 박스 높이(m) — 42U 랙 대략치. */
const UNSIZED_RACK_HEIGHT_M = 2.0

export function objectColor(type: string): string {
  return LAYOUT_OBJECT_COLORS[type] ?? UNKNOWN_OBJECT_COLOR
}

/** 표시명 — `label` 우선, 비었으면 `type`. 둘 다 FMS 원값이다. */
export function objectLabel(object: LayoutObject): string {
  const label = object.label?.trim()
  return label ? label : object.type
}

/**
 * 방위 → three.js Y축 회전(rad).
 *
 * ⚠️ **`dir` 은 오브젝트 정면(FRONT)이 향하는 방위다** — FMS 스키마가 명시하고
 * (`V24` COLUMN COMMENT "정면 방위"), FMS 는 이 값을 변환·반전 없이 그대로 저장·서빙한다(§11-30).
 * **E17 텍스처 작업 때 이 규약을 다시 확인하지 않아도 되게 여기 적어 둔다:
 * FRONT 텍스처는 `dir` 이 가리키는 면에, REAR 는 그 반대 면에 붙인다.**
 * 우리 랙 GLB 는 **로컬 +Z 가 정면**이다(장비 클릭 히트박스가 z = +0.59, 경보 비컨이 z = −0.46).
 *
 * 좌표계(§11-30 3): 원점 (0,0) = 그리드 좌상단, x 증가 = EAST, z 증가 = SOUTH →
 * **NORTH = z 감소**. 나침반 방위각은 N 0° / E 90° / S 180° / W 270°(시계 방향)다.
 *
 * 그런데 three.js Y 회전은 나침반 방위각과 같지 않다. 로컬 +Z 는 회전 θ 에서 월드
 * (sin θ, 0, cos θ) 를 향하는데, 월드 +Z 는 SOUTH 다 → **θ = 180° − 방위각**.
 * (NORTH 180° / EAST 90° / SOUTH 0° / WEST 270°. 아래 표가 그 결과다.)
 */
const DIRECTION_ROTATION_DEGREES: Record<LayoutDirection, number> = {
  NORTH: 180,
  EAST: 90,
  SOUTH: 0,
  WEST: 270,
}

export function directionToRotation(dir: LayoutDirection): number {
  // FMS 계약은 4값뿐이지만 값 검증은 우리 타입이 아니라 서버가 한다(C5) —
  // 모르는 값이 오면 랙이 NaN 회전으로 사라지는 것보다 NORTH 로 두는 편이 낫다.
  const degrees = DIRECTION_ROTATION_DEGREES[dir] ?? DIRECTION_ROTATION_DEGREES.NORTH
  return degrees * Math.PI / 180
}

/** FMS `grid` → 씬 그리드. 규격이 성립하지 않으면 `null`(= 미설정으로 취급, C5). */
function toSceneGrid(layout: ZoneLayout | null): SceneGrid | null {
  const grid = layout?.grid
  if (!grid) return null
  const { cols, rows, tileMm } = grid
  if (!Number.isInteger(cols) || !Number.isInteger(rows) || cols <= 0 || rows <= 0) return null
  if (!Number.isFinite(tileMm) || tileMm <= 0) return null
  return { cols, rows, tileSize: tileMm / 1000 }
}

/** 그리드 안의 정수 좌표인가. 밖이면 그리지 않는다 — 바닥 밖에 뜬 오브젝트가 더 혼란스럽다. */
function toPlacement(object: LayoutObject, grid: SceneGrid): ScenePlacement | null {
  if (!Number.isInteger(object.x) || !Number.isInteger(object.z)) return null
  if (object.x < 0 || object.x >= grid.cols || object.z < 0 || object.z >= grid.rows) return null
  return { tileX: object.x, tileZ: object.z, dir: object.dir, rotation: directionToRotation(object.dir) }
}

/**
 * 박스 높이(m).
 *
 * RACK 만 실치수가 있다 — `objects[].rack.rackUnits`(U 수)로 랙별 높이를 그대로 반영한다.
 * 크기 미설정(null)이면 대략치로 그린다. **높이는 형상이지 표시 수치가 아니므로** 이 폴백이
 * 화면에 숫자로 새지 않는다(랙 크기 표시는 언제나 FMS 원값 `rackUnits`, 미설정이면 `—`).
 */
function objectHeightM(object: LayoutObject): number {
  if (object.type !== 'RACK') return LAYOUT_OBJECT_HEIGHTS_M[object.type] ?? UNKNOWN_OBJECT_HEIGHT_M
  const units = object.rack?.rackUnits
  return typeof units === 'number' && units > 0
    ? RACK_BASE_HEIGHT_M + units * RACK_UNIT_HEIGHT_M
    : UNSIZED_RACK_HEIGHT_M
}

/**
 * netis-fms 랙 목록 + ZONE 배치 + ZONE u맵 → 3D 씬.
 *
 * **페어링은 순서가 아니라 `locationId` 값으로 한다**(u맵 때와 같은 이유 — 서로 다른
 * 엔드포인트 사이의 순서 결합은 깨지기 쉽고 깨져도 조용하다).
 *
 * 두 응답은 **양방향으로 어긋날 수 있고, 각각 다르게 다룬다**:
 * - **랙 목록에 있는데 배치에 없는 랙**(= 배치되지 않음) → `placement: null`.
 *   3D 에는 그리지 않지만 목록·검색·경보·대시보드에는 그대로 남긴다. 좌표를 지어내지
 *   않으면서도 경보 중인 랙이 화면에서 사라지지 않게 하는 유일한 조합이다. 호출부가 수를 밝힌다.
 * - **배치에만 있는 RACK 오브젝트**(랙 목록에 없거나 `rack: null`) → 랙이 아니라 색 박스로
 *   그린다(`objects`). 랙 집합의 SSOT 는 `/zones/{id}/racks` 이므로 여기 있는 것만으로
 *   랙을 만들어내지 않는다 — 온습도·u맵·판정이 없는 랙을 진짜 랙처럼 그리면 클릭했을 때
 *   빈 상세가 뜬다. 박스로 그리면 "FMS 배치도에 이런 오브젝트가 있다"는 사실만 말한다.
 *
 * @param layout `GET /api/layouts/zones/{id}/layout` 응답. `null`이면 아직 못 받은 것이다.
 * @param uMaps `GET /api/zones/{id}/u-maps` 응답. `null`이면 아직 못 받은 것이다.
 */
export function buildZoneScene(
  zoneRacks: RackSummary[] | null,
  layout: ZoneLayout | null,
  uMaps: RackUMap[] | null,
): ZoneScene {
  const grid = toSceneGrid(layout)

  const uMapByLocationId = new Map<number, RackUMap>()
  uMaps?.forEach((uMap) => uMapByLocationId.set(uMap.rack.locationId, uMap))

  /** locationId → 배치. 같은 랙을 가리키는 오브젝트가 둘이면 먼저 온 것만 랙에 붙인다. */
  const placementByLocationId = new Map<number, ScenePlacement>()
  const objects: SceneObject[] = []
  /**
   * 랙 목록을 아직 못 받았으면 `null` — 그때는 "페어링 불가"로 **단정하지 않는다.**
   * 단정하면 랙 목록이 도착하기 전까지 모든 랙이 박스로 그려졌다가 뒤집히는 깜빡임이 된다.
   */
  const knownLocationIds = zoneRacks ? new Set(zoneRacks.map((rack) => rack.locationId)) : null

  if (grid) {
    layout?.objects.forEach((object) => {
      const placement = toPlacement(object, grid)
      if (!placement) return
      const locationId = object.type === 'RACK' ? object.rack?.locationId ?? null : null
      const pairable = locationId !== null
        && (knownLocationIds === null || knownLocationIds.has(locationId))
        && !placementByLocationId.has(locationId)
      if (pairable) {
        placementByLocationId.set(locationId, placement)
        return
      }
      objects.push({
        id: `fms-layout-object-${object.id}`,
        type: object.type,
        label: objectLabel(object),
        color: objectColor(object.type),
        heightM: objectHeightM(object),
        placement,
      })
    })
  }

  const racks = (zoneRacks ?? []).map((rack) => {
    const uMap = uMapByLocationId.get(rack.locationId)
    return {
      id: rackElementId(rack.locationId),
      label: rack.name,
      rackUnits: rack.rackUnits, // FMS 원값(미설정이면 null) — 지어낸 폴백을 두지 않는다
      placement: placementByLocationId.get(rack.locationId) ?? null,
      servers: uMap ? toServerList(uMap) : [],
      uMapKnown: uMap !== undefined,
    }
  })

  return { grid, racks, objects }
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

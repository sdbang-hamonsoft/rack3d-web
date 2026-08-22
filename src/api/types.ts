/**
 * netis-fms 응답 DTO의 rack3d 측 미러.
 *
 * ⚠️ **여기 있는 타입은 FMS가 SSOT다**(D1). 필드를 임의로 늘리거나 이름을 바꾸지 말 것 —
 * 근거 파일을 각 타입 주석에 남긴다. 값이 없을 수 있는 필드는 반드시 `| null`로 둔다:
 * **null을 0으로 치환하는 순간 관제 화면에 가짜 측정값이 뜬다**(C6).
 */

/** `AuthDtos.MenuPermissionSummary` — 프론트 노출 제어용 보조(서버 가드가 SSOT). */
export type MenuPermissionSummary = {
  menu: string
  read: boolean
  write: boolean
  control: boolean
}

/** `AuthDtos.MeResponse` — `GET /api/auth/me`. */
export type MeResponse = {
  username: string
  name: string
  department: string | null
  email: string | null
  mustChangePassword: boolean
  roleGroupName: string | null
  permissions: MenuPermissionSummary[]
}

/**
 * `LocationDtos.SidebarNode` — `GET /api/locations/sidebar` (인증만 필요).
 *
 * `assetCount`/`totalAssetCount`는 **ASSET READ 권한이 있을 때만** 내려온다
 * (`@JsonInclude(NON_NULL)`이라 권한이 없으면 JSON에서 아예 빠진다).
 * 0과 "권한 없음"을 구분해야 하므로 `undefined`를 0으로 바꾸지 않는다.
 */
export type SidebarNode = {
  id: number
  layer: 'BUILDING' | 'FLOOR' | 'ZONE' | 'RACK'
  name: string
  /**
   * `locations.code`는 nullable이고 응답은 `@JsonInclude(NON_NULL)`이라
   * **키 자체가 빠진다**(실응답 대조 §11-10: BUILDING `메인전산실`, ZONE `전산실1층`).
   * `null`이 아니라 `undefined`가 오므로 optional이어야 실제와 맞는다.
   */
  code?: string | null
  sortOrder: number
  assetCount?: number
  totalAssetCount?: number
  children: SidebarNode[]
}

/** `LocationDtos.SidebarResponse`. */
export type SidebarResponse = {
  allLocations: boolean
  roots: SidebarNode[]
}

/** FMS 판정 등급 원값 3단계 + 정상. 라벨 매핑은 rack3d가 한다(E19 C1). */
export type RackSeverity = 'NORMAL' | 'CAUTION' | 'MAJOR' | 'CRITICAL'

/**
 * `RackMapDtos.RackSummary` — `GET /api/zones/{zoneId}/racks` (ASSET READ).
 * E19 B1·B5로 환경·전력·카테고리 집계가 추가된 응답.
 *
 * - `rackUnits`: NULL = 랙 크기 미설정(초과 판정 안 함, E16 정합)
 * - `temp`/`humidity`: 랙에 TH 자산이 없으면 null
 * - `powerKw`: 랙에 DPM 자산이 없으면 null
 * - `collectedAt`: 모니터링 상태 행이 없으면 null (ISO-8601 문자열)
 */
export type RackSummary = {
  locationId: number
  name: string
  code: string | null
  rackUnits: number | null
  assetCount: number
  occupiedUnits: number
  temp: number | null
  humidity: number | null
  powerKw: number | null
  severity: RackSeverity
  collectedAt: string | null
  stale: boolean
  categoryCounts: Record<string, number>
}

/**
 * `RackMapDtos.RackAsset` — `GET /api/racks/{rackLocationId}/u-map` 의 `assets[]` (ASSET READ).
 *
 * **U가 배정된 활성 자산만** 담긴다(`WHERE rack_start_u IS NOT NULL`, §11-11 Q1).
 * 랙 문짝 온습도센서·PDU처럼 U 슬롯을 안 먹는 자산은 여기 없고 {@link RackSummary.categoryCounts}에만 잡힌다.
 *
 * ⚠️ **여기에 장비 상태(정상/경고/장애)는 없다.** netis-fms는 IT 장비 텔레메트리(CPU·온도·트래픽)를
 * 수집하지 않는다(A6 = b 확정). `lifecycleStatus`는 자산 원장의 생애주기 상태일 뿐
 * 실시간 건강 상태가 아니므로 **상태 색·경보로 환산하지 않는다**(C6).
 *
 * 값이 없을 수 있는 필드는 전부 `| null`이다 — 테스트 자산 일부는 제조사·모델명이 실제로 null이다.
 */
export type RackAsset = {
  /** FMS `assets.id`. */
  id: number
  assetCode: string
  name: string
  /** `assets.category` 7종(SERVER·NETWORK·SENSOR 등). 화면 분류의 SSOT. */
  category: string | null
  /** 설비 모니터링 유형(HVAC/DPM/UPS/TH/FIRE/LEAK/ACCESS/NVR). IT 장비는 null. */
  monitoringType: string | null
  manufacturer: string | null
  modelName: string | null
  serialNo: string | null
  spec: string | null
  ip: string | null
  /** 자산 생애주기(OPERATION 등) — **장비 건강 상태가 아니다.** */
  lifecycleStatus: string | null
  /** 랙 하단 기준 시작 U(1-base). */
  rackStartU: number
  /** 끝 U(포함). 높이 = `rackEndU - rackStartU + 1`. */
  rackEndU: number
  /** 자산 실물 이미지 보유 여부(E17). 3D 텍스처는 별도 작업이라 지금은 쓰지 않는다. */
  hasFront: boolean
  hasRear: boolean
}

/** `RackMapDtos.RackUMap.rack` — u맵 응답의 랙 헤더. */
export type RackUMapRack = {
  locationId: number
  name: string
  code: string | null
  /** NULL = 랙 크기 미설정. **이때 U맵을 그리면 안 된다**(42로 지어내는 순간 사고다, C6). */
  rackUnits: number | null
}

/** `RackMapDtos.RackUMap` — `GET /api/racks/{rackLocationId}/u-map`. */
export type RackUMap = {
  rack: RackUMapRack
  assets: RackAsset[]
}

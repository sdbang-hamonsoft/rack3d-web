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
  code: string | null
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

/**
 * netis-fms 엔드포인트 호출 + rack3d 화면이 쓰는 형태로의 변환.
 *
 * 이 파일 밖에서 `api.get('/...')`을 직접 부르지 않는다 — 경로·권한·스코프 규약을 한 곳에 모은다.
 */

import { ApiError, api, NETWORK_ERROR_STATUS } from './client'
import type {
  AssetImageView,
  AssetImages,
  MeResponse,
  RackSummary,
  RackUMap,
  SidebarNode,
  SidebarResponse,
  ZoneLayout,
} from './types'

/** `GET /api/auth/me` — 사용자·권한 요약(인증만 필요). */
export function fetchMe(): Promise<MeResponse> {
  return api.get<MeResponse>('/auth/me')
}

/** `GET /api/locations/sidebar` — 위치 트리(인증만 필요, 위치 스코프로 이미 필터됨). */
export function fetchSidebar(): Promise<SidebarResponse> {
  return api.get<SidebarResponse>('/locations/sidebar')
}

/**
 * `GET /api/zones/{zoneId}/racks` — ZONE 하위 랙 목록 + 환경·전력 집계 (ASSET READ, E19 B1·B5).
 *
 * C5 신뢰 경계: `zoneId`는 **sidebar 응답이 준 id만** 넘긴다. 사용자 입력을 그대로 URL에
 * 끼워 넣지 않도록 정수 여부를 한 번 더 확인한다.
 */
export function fetchZoneRacks(zoneId: number): Promise<RackSummary[]> {
  if (!Number.isInteger(zoneId) || zoneId <= 0) {
    return Promise.reject(new ApiError(NETWORK_ERROR_STATUS, 'INVALID_ZONE_ID'))
  }
  return api.get<RackSummary[]>(`/zones/${zoneId}/racks`)
}

/**
 * `GET /api/zones/{zoneId}/u-maps` — ZONE 하위 **모든 랙**의 U 배치를 한 번에 (ASSET READ).
 *
 * 랙 1대당 1요청이던 `/racks/{id}/u-map`을 대체한다(§11-19). 랙 36대짜리 전산실에서
 * 36요청 순차 스윕이 **1요청**이 되면서, 스윕을 굴리던 기계(커서·간격·부분 실패·중복 가드)가
 * 통째로 필요 없어졌다.
 *
 * 각 요소의 `assets`는 **U가 배정된 활성 자산만**이다(§11-11 Q1). 랙 내 전체 자산 수는
 * `RackSummary.categoryCounts`가 SSOT이며 두 수는 정의가 달라 화면에서 라벨을 나눈다.
 *
 * 랙이 없는 ZONE은 `200 []`, 없는·스코프 밖 ZONE은 `404`다(실측).
 *
 * C5 신뢰 경계: `zoneId`는 **sidebar 응답이 준 id만** 넘긴다.
 */
export function fetchZoneUMaps(zoneId: number): Promise<RackUMap[]> {
  if (!Number.isInteger(zoneId) || zoneId <= 0) {
    return Promise.reject(new ApiError(NETWORK_ERROR_STATUS, 'INVALID_ZONE_ID'))
  }
  return api.get<RackUMap[]>(`/zones/${zoneId}/u-maps`)
}

/**
 * `GET /api/layouts/zones/{zoneId}/layout` — ZONE 3D 배치도 (ASSET READ, E18).
 *
 * 3D 좌표의 **SSOT 는 여기다**. 예전에는 좌표를 `localStorage`(`rack3d-layout:<id>`)에 두고
 * 없으면 자동 배치로 채웠는데, 그래서 **FMS 레이아웃 설정에서 랙을 옮겨도 3D 가 안 바뀌었다**
 * (제품 오너 보고 2026-08-22 — 버그가 아니라 미구현이었다).
 *
 * ⚠️ **랙 집합의 SSOT 는 여전히 {@link fetchZoneRacks} 다.** 여기 `objects[].rack` 은 좌표를
 * 붙이기 위한 참조일 뿐이고, 양쪽이 어긋날 수 있다(실측 ZONE 19: 랙 목록 0건인데 배치에는
 * `type RACK` 오브젝트 1건이 `rack: null` 로 있다). 페어링은 `locationId` **값**으로 한다.
 *
 * 미설정 ZONE 은 `200 { grid: null, objects: [] }`, 없는·ZONE 이 아닌·스코프 밖 id 는 `404`다
 * (실측: BUILDING id 1 → 404. u맵의 `200 []` 과 동작이 다르다).
 *
 * C5 신뢰 경계: `zoneId`는 **sidebar 응답이 준 id만** 넘긴다.
 */
export function fetchZoneLayout(zoneId: number): Promise<ZoneLayout> {
  if (!Number.isInteger(zoneId) || zoneId <= 0) {
    return Promise.reject(new ApiError(NETWORK_ERROR_STATUS, 'INVALID_ZONE_ID'))
  }
  return api.get<ZoneLayout>(`/layouts/zones/${zoneId}/layout`)
}

// ── 장비 실물 사진(E17) ──────────────────────────────────────────────────────

/** 자산 id 검증 — C5 신뢰 경계. id는 **u맵 응답이 준 값만** 온다. */
function assetPath(assetId: number): string | null {
  return Number.isInteger(assetId) && assetId > 0 ? `/assets/${assetId}` : null
}

/**
 * `GET /api/assets/{assetId}/images` — 앞/뒤 사진 메타(ASSET READ).
 *
 * 바이트를 받기 전에 이걸 먼저 부르는 이유는 **`sha256`** 하나다 — 텍스처 URL에 `?v=<sha>`로
 * 붙여야 FMS가 장기 캐시로 답하고(§11-15), 사진이 교체되면 URL이 바뀌어 자동 반영된다.
 */
export function fetchAssetImages(assetId: number): Promise<AssetImages> {
  const path = assetPath(assetId)
  if (!path) return Promise.reject(new ApiError(NETWORK_ERROR_STATUS, 'INVALID_ASSET_ID'))
  return api.get<AssetImages>(`${path}/images`)
}

/**
 * `sha256`은 FMS가 준 값이지만 URL에 넣기 전에 형태를 확인한다(C5) — **소문자** 16진 64자.
 *
 * 대소문자를 함께 받지 않는 이유: 같은 바이트가 `?v=ABC…`/`?v=abc…` 두 URL로 갈리면
 * 브라우저 캐시도 `photoCacheKey`도 이중으로 잡힌다. 실측상 FMS는 소문자로만 주므로
 * (§11-15·`types.ts`) 대문자가 오면 계약을 벗어난 값으로 보고 `v`를 **붙이지 않는다** —
 * 그래도 사진은 그대로 나오고 캐시 수명만 짧아진다(지어낸 값으로 채우는 것보다 안전하다).
 */
const SHA256_HEX = /^[0-9a-f]{64}$/

/**
 * `GET /api/assets/{assetId}/images/{view}?variant=texture&v=<sha>` — 3D 텍스처용 축소본.
 *
 * - `variant=texture`: FMS가 만든 JPEG 파생본(원본은 PNG). **실측 880 × 80×U**
 *   (자산 5 = 2U → 880×160 · 9,855 B, 자산 45 = 4U → 880×320 · 13,267 B).
 *   "1024px 축소본"이라는 계약이지만 원본이 이미 폭 880이라 실제로는 줄어들지 않는다.
 * - `v=<sha256>`: 캐시 키(§11-15). FMS가 `v` 분기를 배포하기 전이어도 **동작에는 영향이 없다** —
 *   지금은 기존 `max-age=60`으로 응답할 뿐이다(실측 확인).
 *
 * sha를 모르면 `v`를 **붙이지 않는다.** 아무 값이나 채우면 사진이 교체돼도 URL이 그대로라
 * 1년짜리 캐시에 옛 바이트가 박힌다 — 지어낸 값이 정확히 사고가 되는 자리다(C6).
 */
export function fetchAssetPhoto(assetId: number, view: AssetImageView, sha256: string | null): Promise<Blob> {
  const path = assetPath(assetId)
  if (!path) return Promise.reject(new ApiError(NETWORK_ERROR_STATUS, 'INVALID_ASSET_ID'))
  const version = sha256 && SHA256_HEX.test(sha256) ? `&v=${encodeURIComponent(sha256)}` : ''
  return api.getBlob(`${path}/images/${view}?variant=texture${version}`)
}

// ── 사이드바 트리 → 전산실(ZONE) 목록 ────────────────────────────────────────

/** 화면이 쓰는 전산실 1건. 값의 출처는 전부 FMS다(D1) — 여기서 임의 값을 만들지 않는다. */
export type ZoneSummary = {
  /** FMS `locations.id` — 이후 모든 ZONE 스코프 호출의 유일한 입력(C5). */
  id: number
  name: string
  /** FMS `locations.code` — 미설정이면 null(화면에서 `—`). */
  code: string | null
  /** 상위 위치 경로(건물 > 층). 스코프 사용자면 보이는 조상까지만. */
  path: string
  /** 사이드바 트리에 실린 RACK 레이어 자식 수 — 등록된 랙 수. */
  rackCount: number
  /** 자기+후손 자산 수. **ASSET READ가 없으면 응답에서 빠지므로 null**(0이 아니다). */
  totalAssetCount: number | null
}

/** 사이드바 트리를 훑어 ZONE 레이어 노드만 뽑는다. */
export function collectZones(roots: SidebarNode[]): ZoneSummary[] {
  const zones: ZoneSummary[] = []

  const walk = (node: SidebarNode, ancestors: string[]) => {
    if (node.layer === 'ZONE') {
      zones.push({
        id: node.id,
        name: node.name,
        code: node.code ?? null,
        path: ancestors.join(' › '),
        rackCount: node.children.filter((child) => child.layer === 'RACK').length,
        totalAssetCount: node.totalAssetCount ?? null,
      })
      return // ZONE 아래는 RACK이라 더 내려갈 필요가 없다.
    }
    node.children.forEach((child) => walk(child, [...ancestors, node.name]))
  }

  roots.forEach((root) => walk(root, []))
  return zones
}

// ── 에러 → 화면 상태 ─────────────────────────────────────────────────────────

/**
 * 화면이 분기할 수 있는 에러 종류.
 *
 * `forbidden`은 **권한 없음 + 위치 스코프 밖**을 함께 담는다: FMS는 스코프 밖 응답을
 * 엔드포인트마다 다르게 준다(`racks`·`series/zone`은 404, `overview`는 200 + 빈 집계).
 * **두 패턴을 모두 "권한 없음"으로 수렴**시켜야 빈 화면을 정상으로 오인하지 않는다(R7).
 */
export type ApiFailureKind = 'network' | 'forbidden' | 'unknown'

export type ApiFailure = {
  kind: ApiFailureKind
  /** 사용자에게 보여줄 문구. **FMS 응답 원문이 아니라 rack3d가 고른 문장이다**(C8). */
  message: string
  /** 429 `Retry-After`(I-7). 폴링이 다음 요청을 이만큼 미룬다. 없으면 null. */
  retryAfterMs: number | null
}

/** 서버 응답 원문을 쓰지 않고 status/code만으로 표시 문구를 고른다(C8). */
export function describeFailure(error: unknown): ApiFailure {
  const plain = (kind: ApiFailureKind, message: string): ApiFailure => ({ kind, message, retryAfterMs: null })

  if (!(error instanceof ApiError)) return plain('unknown', '데이터를 불러오지 못했습니다.')
  // 프로그래밍 오류(잘못된 id 등)를 "네트워크를 확인하세요"로 표시하면 원인 추적이 어긋난다.
  if (error.code === 'INVALID_ZONE_ID') return plain('unknown', '조회할 전산실을 확인하지 못했습니다.')
  if (error.status === NETWORK_ERROR_STATUS) {
    return error.code === 'TIMEOUT'
      ? plain('network', 'netis-fms 응답이 없어 요청을 중단했습니다.')
      : plain('network', 'netis-fms에 연결하지 못했습니다. 네트워크 상태를 확인하세요.')
  }
  if (error.status === 403 || error.status === 404) {
    return plain('forbidden', '이 전산실을 볼 권한이 없거나 조회 범위에 포함되어 있지 않습니다.')
  }
  if (error.status === 429) {
    // 실제 대기는 이 값과 폴링 하한 중 **긴 쪽**이라 여기서 초를 문구에 박으면 거짓이 된다
    // (Retry-After: 0이면 "0초 후"라고 말하고 실제로는 30초 뒤에 간다).
    // 남은 시간은 폴링 훅이 실제 스케줄에서 계산해 화면에 카운트다운으로 보여준다.
    const retryAfterMs = error.retryAfterSeconds !== null ? error.retryAfterSeconds * 1000 : null
    return { kind: 'unknown', message: '요청이 많아 잠시 후 다시 시도합니다.', retryAfterMs }
  }
  return plain('unknown', '데이터를 불러오지 못했습니다.')
}

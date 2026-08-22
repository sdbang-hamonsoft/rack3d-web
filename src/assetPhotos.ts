/**
 * netis-fms 장비 실물 사진(E17) — 수급·캐시·로딩 우선순위.
 *
 * 3D 랙 안의 장비는 GLB 3종을 돌려 쓰기 때문에 **앞뒤면에 구워진 사진이 모두 같다**
 * (Dell 자산은 전부 같은 그림). 그 평면의 텍스처를 자산별 실물 사진으로 갈아끼우는 것이
 * E17이고, 이 파일은 그 사진을 **언제·몇 장·어떤 순서로** 받을지를 정한다.
 *
 * three.js 텍스처 객체는 여기서 만들지 않는다 — 만든 쪽이 `dispose()`까지 책임지게(C12)
 * **장비 컴포넌트가 자기 텍스처를 소유**하고, 이 파일은 그 재료(디코드된 이미지 + 실비율)만
 * 준다. 그래서 씬을 떠나면 GPU 텍스처는 전부 사라지고, 다시 들어오면 **네트워크 없이**
 * 캐시된 이미지로 재업로드된다.
 *
 * 규약: C1(토큰 비노출 — 요청은 전부 `api/fms`를 거친다) · C5(자산 id는 u맵 응답값만) ·
 * C6(사진이 없으면 지어내지 않는다 — 호출부가 GLB 기본 사진을 그대로 둔다) · C12(정리).
 * CSP: FMS는 `img-src 'self' data: blob:`이라 `fetch` → `blob:` URL 경로가 동작한다.
 * 외부 CDN·wasm은 쓰지 않는다(C10).
 */

// `ApiError`는 요청이 아니라 에러 형태를 읽기 위한 것이다 — 호출은 여전히 `api/fms`만 거친다(C1).
import { ApiError } from './api/client'
import { fetchAssetImages, fetchAssetPhoto } from './api/fms'
import type { AssetImageView, AssetImages } from './api/types'

// ── 정책 상수 ───────────────────────────────────────────────────────────────
//
// ⚠️ **진입 시 전량 로딩은 하지 않는다.** 지금 UAT 데이터는 자산 8대(16장·약 160 KB)라
// 무엇을 해도 티가 안 나지만, 실고객은 랙 수십 대 × 장비 수백 대다. GPU 텍스처는 압축이
// 풀린 픽셀로 올라가므로(880×320 JPEG 13 KB → VRAM 약 1.1 MB + 밉맵) 전량 로딩은
// 파일 크기가 아니라 **VRAM**에서 터진다.

/**
 * 앞면 사진을 받기 시작하는 카메라 거리(m).
 *
 * 근거: 1U는 44.45 mm다. FOV 62°(수직) 뷰포트 높이 1080 px에서 거리 d의 1U 화면 높이는
 * `1080 × 0.04445 / (2 d tan31°)` ≈ `40/d` px다 → 9 m에서 약 4.4 px. 그 아래로는 사진이
 * 한두 픽셀 띠로 뭉개져 회색 판과 구분되지 않으므로 받을 이유가 없다.
 * ZONE 10 진입 기본 카메라(12×8 그리드)에서 가까운 랙 열은 이 안에 들고, 18×14 ZONE의
 * 먼 열은 밖이다 — 요구된 "가까운 랙부터 점진적으로"가 이 값 하나로 나온다.
 */
const PHOTO_ACQUIRE_RADIUS_M = 9

/**
 * 이미 붙인 사진을 떼는 거리(m). 획득 반경보다 넓다 — **히스테리시스**가 없으면 경계에
 * 걸친 랙이 카메라 미세 이동마다 붙었다 떨어졌다 하며 GPU 업로드를 반복한다.
 */
const PHOTO_RELEASE_RADIUS_M = 11

/**
 * 뒷면 판정용 코사인 임계. 랙 정면 법선과 (카메라 − 랙) 방향의 내적이다.
 * 0보다 작으면 카메라가 랙 뒤에 있다. 획득 −0.10 / 해제 +0.10으로 벌려 경계 떨림을 막는다.
 */
const REAR_ACQUIRE_COS = -0.1
const REAR_RELEASE_COS = 0.1

/**
 * 동시에 붙여 두는 사진 장수 상한.
 *
 * 근거: 최악(전부 4U, 880×320)이 장당 약 1.5 MB(밉맵 포함)이므로 48장 ≈ 72 MB, 흔한 1~2U는
 * 장당 0.2~0.6 MB라 20 MB 안쪽이다. 관제 PC 브라우저 탭 하나가 감당할 상한으로 잡았다.
 * ZONE 10은 자산 8대라 이 상한에 닿지 않는다 — **지금 데이터로는 거리 규칙만 실제로 동작한다.**
 */
const MAX_ACTIVE_PHOTOS = 48

/**
 * 개수 상한에 걸렸을 때 **이미 붙어 있는 사진을 밀어내는 데 필요한 거리 우위(m).**
 *
 * 거리(9/11 m)·뒷면(cos ∓0.10)과 같은 이유로 **개수 상한에도 히스테리시스가 필요하다.**
 * 후보가 상한을 넘긴 뒤 매 틱 "거리순 상위 48"을 그대로 따르면, 상한 언저리의 순위가 카메라
 * 4 px 회전(랙까지 거리로는 수 cm)에도 뒤바뀌며 매 계획 틱(400 ms)마다 붙였다 떼는 것이
 * 반복된다 — 랙 36대·사진 188면에서 초당 79회 업로드가 실측됐다(E17 QA). 관제 화면이 틀린
 * 값을 내는 문제는 아니지만, 이 로딩 정책이 대비하려던 바로 그 규모에서 목적을 잃는다.
 *
 * 그래서 자리가 없을 때는 **이만큼 확실히 가까운 후보만** 가장 먼 것을 밀어낸다. 랙 간격이
 * 0.6~1.2 m이므로 1 m는 "한 줄 이상 가까워졌다"는 뜻이고, 수 cm짜리 순위 진동은 무시된다.
 * 포커스한 랙은 우선순위가 −1000이라 이 문턱을 언제나 넘는다 — 포커스 즉시 사진이 붙는 동작은
 * 그대로다.
 */
const PHOTO_EVICT_MARGIN_M = 1

/** 동시 요청 수. 브라우저 HTTP/1.1 호스트당 6 연결 중 폴링 몫을 남긴다(FMS 조회는 무제한, §11-16). */
const MAX_CONCURRENT_LOADS = 4

/**
 * 디코드된 이미지 캐시 상한(장).
 *
 * **전산실을 나갔다 들어와도 다시 받지 않게** 하는 것이 이 캐시의 목적이다. 씬을 떠나면
 * GPU 텍스처는 사라지지만 여기 남은 바이트로 재업로드하므로 왕복이 0이다.
 * 원본 blob은 장당 10~15 KB라 192장이라도 2~3 MB고, 디코드본은 브라우저가 필요에 따라
 * 버렸다 다시 디코드한다(그래서 `blob:` URL을 캐시가 살아 있는 동안 유지한다).
 *
 * ⚠️ **동시 보유 상한({@link MAX_ACTIVE_PHOTOS})보다 넉넉히 커야 한다.** 두 값이 붙어 있으면
 * (구 64 vs 48) 카메라가 조금만 움직여도 밀려난 항목의 `blob:`이 revoke되고, 그 사진이 다시
 * 필요해질 때 바이트를 처음부터 다시 받는다 — 랙 36대에서 고유 162장에 fetch 8,676회가
 * 실측된 고리다. 3배 이상 벌려 두면 시야 왕복이 캐시 안에서 끝난다.
 */
const IMAGE_CACHE_LIMIT = 192

/**
 * 사진 메타(`/images`) 캐시 수명.
 *
 * 사진은 누가 FMS에서 교체하기 전까지 불변이라 매번 물을 이유가 없다. 다만 **영구 캐시는
 * 교체된 사진이 영영 안 보이는 상태**를 만든다 — 5분이면 실무상 "바꾸고 새로고침하니 나온다"가
 * 성립하는 상한이다. 메타가 같은 sha를 주면 이미지 캐시가 그대로 맞아 바이트 왕복은 0이다.
 */
const META_TTL_MS = 5 * 60_000

/**
 * 실패 후 재시도 금지 시간. 404·403·네트워크 실패를 매 틱 다시 두드리면 관제 화면이
 * 스스로 요청 폭풍을 만든다. 사진은 없어도 화면이 성립하므로(GLB 기본 사진 유지) 급하지 않다.
 */
const FAILURE_COOLDOWN_MS = 60_000

/**
 * 이번 실패의 재시도 금지 시간(ms).
 *
 * 서버가 `Retry-After`로 "이만큼 기다리라"고 말하면 그 값을 따른다 — FMS가 rack3d 백오프용으로
 * 일부러 넣어 준 헤더이고(`api/client.ts`의 `ApiError.retryAfterSeconds`), 폴링 경로는 이미
 * 지키고 있다. 사진 경로만 예외로 두면 나중에 왜 한쪽만 다른지 설명할 근거가 없다.
 * 지금 FMS 조회 계열에 레이트리밋은 없지만(§11-16) 프록시·게이트웨이가 끼면 여전히 올 수 있다.
 *
 * - **상한은 다시 두지 않는다** — `client.ts`가 파싱 시점에 이미 300초로 자른다.
 * - 헤더 값이 기본 쿨다운보다 짧아도 **줄이지는 않는다.** 사진은 없어도 화면이 성립하므로
 *   서버가 허락한다고 서둘러 다시 두드릴 이유가 없다.
 */
function failureCooldownMs(error: unknown): number {
  if (error instanceof ApiError && error.retryAfterSeconds !== null) {
    return Math.max(FAILURE_COOLDOWN_MS, error.retryAfterSeconds * 1000)
  }
  return FAILURE_COOLDOWN_MS
}

// ── 디코드된 사진 ───────────────────────────────────────────────────────────

/** 텍스처 재료 1건. `aspect`는 **디코드된 실픽셀 비율**이지 우리가 가정한 값이 아니다. */
export type AssetPhoto = {
  image: HTMLImageElement
  width: number
  height: number
  /** `width / height`. 사진 평면의 종횡비 보정 기준(§11-14). */
  aspect: number
}

type CacheEntry = AssetPhoto & { objectUrl: string }

/** 자산 id + 면 + sha — sha가 바뀌면 키가 달라져 **새 사진이 자동 반영**된다. */
function photoCacheKey(assetId: number, view: AssetImageView, sha256: string): string {
  return `${assetId}:${view}:${sha256}`
}

/** 요청 중복 제거·수요 우선순위용 키(sha 무관 — 같은 면은 한 번만 진행한다). */
function requestKey(assetId: number, view: AssetImageView): string {
  return `${assetId}:${view}`
}

/** 삽입 순서 = LRU 순서(Map 규약). `get` 시 재삽입으로 최근 사용을 뒤로 민다. */
const imageCache = new Map<string, CacheEntry>()

/**
 * 캐시 세대. 세션 정리 시점에 올린다 — 정리 직전에 떠 있던 요청이 **정리 뒤에 도착해
 * 캐시를 되살리는 것**을 막는다(로그아웃했는데 이전 사용자의 자산 사진이 남는 경로다).
 */
let cacheGeneration = 0

function readCache(key: string): CacheEntry | null {
  const entry = imageCache.get(key)
  if (!entry) return null
  imageCache.delete(key)
  imageCache.set(key, entry)
  return entry
}

function writeCache(key: string, entry: CacheEntry) {
  imageCache.set(key, entry)
  while (imageCache.size > IMAGE_CACHE_LIMIT) {
    const oldestKey = imageCache.keys().next().value
    if (oldestKey === undefined) break
    const evicted = imageCache.get(oldestKey)
    imageCache.delete(oldestKey)
    if (evicted) URL.revokeObjectURL(evicted.objectUrl)
  }
}

// ── 메타 캐시 ───────────────────────────────────────────────────────────────

type MetaEntry = { at: number; images: AssetImages }

const metaCache = new Map<number, MetaEntry>()
const metaInFlight = new Map<number, Promise<AssetImages>>()

function peekMeta(assetId: number): AssetImages | null {
  const entry = metaCache.get(assetId)
  if (!entry) return null
  if (Date.now() - entry.at > META_TTL_MS) {
    metaCache.delete(assetId)
    return null
  }
  return entry.images
}

/** 같은 자산에 대한 동시 요청은 하나로 묶는다(앞·뒤가 동시에 뜨는 것이 기본 경로다). */
function loadMeta(assetId: number): Promise<AssetImages> {
  const cached = peekMeta(assetId)
  if (cached) return Promise.resolve(cached)
  const existing = metaInFlight.get(assetId)
  if (existing) return existing
  const generation = cacheGeneration
  const request = fetchAssetImages(assetId)
    .then((images) => {
      // 응답이 도는 사이 세션이 끊겼으면 캐시에 남기지 않는다(이미지 쪽과 같은 규칙).
      if (generation === cacheGeneration) metaCache.set(assetId, { at: Date.now(), images })
      return images
    })
    .finally(() => metaInFlight.delete(assetId))
  metaInFlight.set(assetId, request)
  return request
}

// ── 수요 상태(계획기가 쓰고, 큐 정렬이 읽는다) ──────────────────────────────

export const PHOTO_DEMAND_FRONT = 1
export const PHOTO_DEMAND_REAR = 2

/** assetId → 비트마스크. 구독자(장비 컴포넌트)가 자기 것만 읽는다. */
const demand = new Map<number, number>()
/** `${assetId}:${view}` → 우선순위(작을수록 급함). 큐 정렬이 이 값을 본다. */
const demandPriority = new Map<string, number>()
const demandListeners = new Map<number, Set<() => void>>()

// ── 요청 큐(동시성 + 우선순위) ──────────────────────────────────────────────

type QueueItem = { key: string; run: () => void }

const queue: QueueItem[] = []
let activeLoads = 0

/**
 * 대기열에서 **지금 가장 급한 것**을 꺼낸다. 우선순위는 큐에 넣을 때가 아니라 **꺼낼 때**
 * 읽는다 — 큐에 있는 동안 카메라가 움직이면 급한 것이 바뀌기 때문이다.
 */
function dequeue(): QueueItem | null {
  if (queue.length === 0) return null
  let bestIndex = 0
  let bestPriority = demandPriority.get(queue[0].key) ?? Number.MAX_SAFE_INTEGER
  for (let index = 1; index < queue.length; index += 1) {
    const priority = demandPriority.get(queue[index].key) ?? Number.MAX_SAFE_INTEGER
    if (priority < bestPriority) {
      bestPriority = priority
      bestIndex = index
    }
  }
  return queue.splice(bestIndex, 1)[0]
}

function pump() {
  while (activeLoads < MAX_CONCURRENT_LOADS) {
    const item = dequeue()
    if (!item) return
    activeLoads += 1
    item.run()
  }
}

function withSlot<T>(key: string, task: () => Promise<T>): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    queue.push({
      key,
      run: () => {
        task()
          .then(resolve, reject)
          .finally(() => {
            activeLoads -= 1
            pump()
          })
      },
    })
    pump()
  })
}

// ── 로딩 ───────────────────────────────────────────────────────────────────

const inFlightPhotos = new Map<string, Promise<AssetPhoto>>()
const failedUntil = new Map<string, number>()

/** blob → 디코드된 이미지. `blob:` URL은 캐시에서 밀려날 때까지 유지한다(재업로드 대비). */
function decodeBlob(blob: Blob): Promise<CacheEntry> {
  return new Promise((resolve, reject) => {
    const objectUrl = URL.createObjectURL(blob)
    const image = new Image()
    image.onload = () => {
      const width = image.naturalWidth
      const height = image.naturalHeight
      if (width <= 0 || height <= 0) {
        URL.revokeObjectURL(objectUrl)
        reject(new Error('EMPTY_IMAGE'))
        return
      }
      resolve({ image, width, height, aspect: width / height, objectUrl })
    }
    image.onerror = () => {
      URL.revokeObjectURL(objectUrl)
      reject(new Error('DECODE_FAILED'))
    }
    image.src = objectUrl
  })
}

async function runLoad(assetId: number, view: AssetImageView): Promise<AssetPhoto> {
  const generation = cacheGeneration
  const meta = await loadMeta(assetId)
  const entry = view === 'FRONT' ? meta.front : meta.rear
  // 메타가 "이 면은 없다"고 하면 그대로 없는 것이다 — 다른 면으로 대신 채우지 않는다(C6).
  if (!entry) throw new Error('NO_IMAGE')
  const cacheKey = photoCacheKey(assetId, view, entry.sha256)
  const cached = readCache(cacheKey)
  if (cached) return cached
  const blob = await fetchAssetPhoto(assetId, view, entry.sha256)
  const decoded = await decodeBlob(blob)
  if (generation === cacheGeneration) {
    writeCache(cacheKey, decoded)
  } else {
    // 이 요청이 도는 사이 세션이 끊겼다 — 캐시에 남기지 않고 이 호출에만 쓴다.
    URL.revokeObjectURL(decoded.objectUrl)
  }
  return decoded
}

/**
 * 자산 사진 1장. 이미 받은 것은 **네트워크 없이** 돌려준다.
 *
 * 실패는 삼키지 않고 그대로 올린다 — 호출부가 "GLB 기본 사진 유지"를 선택해야 하고,
 * 여기서 다른 사진으로 대신 채우는 순간 관제 화면이 거짓말을 한다(C6).
 */
export function loadAssetPhoto(assetId: number, view: AssetImageView): Promise<AssetPhoto> {
  const key = requestKey(assetId, view)

  const cooldownUntil = failedUntil.get(key)
  if (cooldownUntil !== undefined) {
    if (Date.now() < cooldownUntil) return Promise.reject(new Error('COOLDOWN'))
    failedUntil.delete(key)
  }

  // 캐시 적중은 큐를 거치지 않는다 — 슬롯을 잡으면 실제 다운로드가 그만큼 밀린다.
  const meta = peekMeta(assetId)
  const metaEntry = meta ? (view === 'FRONT' ? meta.front : meta.rear) : null
  if (metaEntry) {
    const cached = readCache(photoCacheKey(assetId, view, metaEntry.sha256))
    if (cached) return Promise.resolve(cached)
  }

  const existing = inFlightPhotos.get(key)
  if (existing) return existing

  const request = withSlot(key, () => runLoad(assetId, view))
    .catch((error: unknown) => {
      failedUntil.set(key, Date.now() + failureCooldownMs(error))
      throw error
    })
    .finally(() => inFlightPhotos.delete(key))
  inFlightPhotos.set(key, request)
  return request
}

// ── 수요 계획(어떤 사진을 지금 붙일 것인가) ─────────────────────────────────

/** 계획기가 매 틱 넘기는 랙 안 장비 1건의 현재 상황. 값은 전부 씬에서 계산된다. */
export type PhotoDemandInput = {
  assetId: number
  hasFront: boolean
  hasRear: boolean
  /** 카메라 ↔ 랙 중심 거리(m). */
  distanceM: number
  /** 랙 정면 법선 · (카메라 − 랙) 단위벡터 내적. 음수면 카메라가 뒤에 있다. */
  facingCos: number
  /** 이 랙이 포커스 중인가. 포커스 랙은 거리·방향과 무관하게 앞뒤를 모두 받는다. */
  focused: boolean
}

export function subscribePhotoDemand(assetId: number, listener: () => void): () => void {
  let listeners = demandListeners.get(assetId)
  if (!listeners) {
    listeners = new Set()
    demandListeners.set(assetId, listeners)
  }
  listeners.add(listener)
  return () => {
    listeners.delete(listener)
    if (listeners.size === 0) demandListeners.delete(assetId)
  }
}

export function getPhotoDemand(assetId: number): number {
  return demand.get(assetId) ?? 0
}

function notify(assetId: number) {
  demandListeners.get(assetId)?.forEach((listener) => listener())
}

type Candidate = { assetId: number; bit: number; key: string; priority: number }

/**
 * 수요 재계산. 씬(카메라·랙 배치)에서 계산한 값만 받는다.
 *
 * 규칙:
 * 1. **앞면** — 포커스 랙이거나 카메라 반경 안. 이미 붙어 있으면 더 넓은 해제 반경을 쓴다.
 * 2. **뒷면** — 포커스 랙이거나, 카메라가 랙 **뒤쪽**에 있고 반경 안일 때만. 앞에서 보는 랙의
 *    뒷면은 화면에 1픽셀도 나오지 않으므로 받을 이유가 없다.
 * 3. 같은 랙이면 앞면이 먼저, 랙끼리는 가까운 쪽이 먼저.
 * 4. 총량은 {@link MAX_ACTIVE_PHOTOS}로 자른다. 상한에 걸린 뒤의 **교체에는 히스테리시스**가
 *    있다 — {@link PHOTO_EVICT_MARGIN_M} 이상 가까운 후보만 가장 먼 것을 밀어낸다.
 */
export function publishPhotoDemand(inputs: PhotoDemandInput[]) {
  const candidates: Candidate[] = []

  inputs.forEach((input) => {
    const base = input.focused ? -1000 : input.distanceM
    if (input.hasFront) {
      const key = requestKey(input.assetId, 'FRONT')
      const held = (demand.get(input.assetId) ?? 0) & PHOTO_DEMAND_FRONT
      const radius = held ? PHOTO_RELEASE_RADIUS_M : PHOTO_ACQUIRE_RADIUS_M
      if (input.focused || input.distanceM <= radius) {
        candidates.push({ assetId: input.assetId, bit: PHOTO_DEMAND_FRONT, key, priority: base })
      }
    }
    if (input.hasRear) {
      const key = requestKey(input.assetId, 'REAR')
      const held = (demand.get(input.assetId) ?? 0) & PHOTO_DEMAND_REAR
      const radius = held ? PHOTO_RELEASE_RADIUS_M : PHOTO_ACQUIRE_RADIUS_M
      const facingLimit = held ? REAR_RELEASE_COS : REAR_ACQUIRE_COS
      if (input.focused || (input.distanceM <= radius && input.facingCos < facingLimit)) {
        // +0.001 — 같은 랙에서 앞면을 먼저 받게 하는 최소 차이다.
        candidates.push({ assetId: input.assetId, bit: PHOTO_DEMAND_REAR, key, priority: base + 0.001 })
      }
    }
  })

  candidates.sort((a, b) => a.priority - b.priority)

  // 이미 붙어 있는 것을 먼저 그대로 담는다 — 상한을 넘긴 몫만 먼 것부터 잘린다.
  const kept: Candidate[] = []
  const fresh: Candidate[] = []
  candidates.forEach((candidate) => {
    const held = ((demand.get(candidate.assetId) ?? 0) & candidate.bit) !== 0
    if (!held) fresh.push(candidate)
    else if (kept.length < MAX_ACTIVE_PHOTOS) kept.push(candidate)
  })

  // 남은 자리는 가까운 것부터 채운다. 자리가 없으면 **유의미하게 가까울 때만** 밀어낸다
  // — 순위 진동에 반응하면 카메라가 4 px만 움직여도 GPU 업로드가 폭주한다.
  for (const candidate of fresh) {
    if (kept.length < MAX_ACTIVE_PHOTOS) {
      kept.push(candidate)
      continue
    }
    let worst = 0
    for (let index = 1; index < kept.length; index += 1) {
      if (kept[index].priority > kept[worst].priority) worst = index
    }
    // `fresh`도 우선순위 오름차순이라, 여기서 걸리면 뒤는 볼 것도 없다.
    if (candidate.priority + PHOTO_EVICT_MARGIN_M >= kept[worst].priority) break
    kept[worst] = candidate
  }

  const next = new Map<number, number>()
  demandPriority.clear()
  kept.forEach((candidate) => {
    next.set(candidate.assetId, (next.get(candidate.assetId) ?? 0) | candidate.bit)
    demandPriority.set(candidate.key, candidate.priority)
  })

  // **바뀐 자산에만** 알린다 — 매 틱 전원 리렌더는 랙 수십 대에서 그대로 비용이 된다.
  const touched = new Set<number>([...demand.keys(), ...next.keys()])
  const previous = new Map(demand)
  demand.clear()
  next.forEach((mask, assetId) => demand.set(assetId, mask))
  touched.forEach((assetId) => {
    if ((previous.get(assetId) ?? 0) !== (next.get(assetId) ?? 0)) notify(assetId)
  })
}

/**
 * 씬을 떠날 때. 수요를 비우면 장비 컴포넌트가 정리 경로를 타고 텍스처를 반납한다(C12).
 *
 * ⚠️ **대기 중인 요청을 버리지 않는다.** 큐에서 빼 버리면 그 약속(Promise)이 영영 안 끝나
 * `inFlightPhotos`에 남고, 다시 들어왔을 때 그 죽은 약속이 그대로 반환돼 사진이 영영 안 붙는다.
 * 남은 요청은 몇 KB짜리라 그대로 끝내고 캐시에 넣는 편이 재진입에도 유리하다.
 */
export function clearPhotoDemand() {
  const touched = [...demand.keys()]
  demand.clear()
  demandPriority.clear()
  touched.forEach(notify)
}

/**
 * 세션이 끝났을 때의 전면 정리(C12).
 *
 * GPU 텍스처는 장비 컴포넌트가 언마운트되며 이미 `dispose()`된다 — 여기서 버리는 것은
 * **디코드된 이미지와 메타**다. 다른 사용자로 다시 로그인했을 때 이전 사용자가 볼 수 있던
 * 자산 사진이 캐시에 남아 있으면 안 된다.
 */
export function clearAssetPhotoCache() {
  cacheGeneration += 1
  clearPhotoDemand()
  imageCache.forEach((entry) => URL.revokeObjectURL(entry.objectUrl))
  imageCache.clear()
  metaCache.clear()
  failedUntil.clear()
}

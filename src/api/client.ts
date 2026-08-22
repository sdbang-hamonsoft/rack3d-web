/**
 * netis-fms API fetch 래퍼.
 *
 * 참고 구현: `netis-fms/frontend/src/api/client.ts` — 검증된 동작(재시도 1회, auth 경로 제외,
 * 세션 파기)을 그대로 유지하고 rack3d에 필요 없는 부분(업로드/다운로드/페이징)은 덜어냈다.
 *
 * 규약 (docs/fms-integration-security.md §7-A):
 * - rack3d는 FMS와 **같은 오리진**의 하위 경로(`https://<fms>/rack3d/`)로 서빙된다(D4).
 *   따라서 API는 **상대 경로 `/api/...`** 로만 호출한다 — 절대 URL·CORS·credentials 설정 없음.
 * - C1: 액세스 토큰은 **메모리(모듈 변수)에만** 둔다. localStorage/sessionStorage/쿠키/URL 금지.
 *   토큰을 밖으로 꺼내는 getter도 두지 않는다(로그·에러 리포팅 유출 차단).
 * - C2: 401 → refresh **1회만** 재시도. 동시 401이 refresh를 중복 호출하지 않도록 single-flight.
 * - C3: 인증 플로우 자체(`/auth/login`·`/auth/otp/*`·`/auth/refresh`·`/auth/logout`)는 재시도 제외.
 * - C4: 403 `PASSWORD_CHANGE_REQUIRED`는 rack3d가 처리하지 않고 FMS 화면으로 넘긴다.
 * - C11: **선제 갱신 타이머는 탭이 보이는 동안에만** 건다(아래 "선제 갱신" 절).
 * - C8: 에러는 FMS `ErrorResponse{code, message}` 형식이지만 **응답 원문(message)은 보관하지 않는다.**
 *   화면 분기는 `status` + `code`로만 한다.
 */

/** 리프레시 토큰은 HttpOnly 쿠키(`NETIS_RT`, Path=/api/auth)라 JS에서 접근할 수 없다. */
const BASE_URL = '/api'

/** FMS `TokenResponse`와 동일 — **이 모듈 밖으로 나가지 않는다**(C1). */
type TokenResponse = {
  accessToken: string
  expiresInSeconds: number
  mustChangePassword: boolean
  user: { username: string; name: string }
}

/**
 * `tryRefresh()`가 밖에 내주는 것 — 토큰은 빼고 세션 계층이 실제로 쓰는 값만 담는다.
 * (토큰을 반환하면 호출부·로그·에러 리포팅으로 새어 나갈 통로가 생긴다.)
 */
export type RefreshOutcome = {
  mustChangePassword: boolean
}

/**
 * FMS 에러 응답의 안전한 표현.
 *
 * 서버가 보낸 `message`는 **의도적으로 담지 않는다**(C8) — 내부 경로·스택이 섞여 들어올 수 있는
 * 문자열을 화면이 실수로 렌더링하지 못하게 타입 수준에서 막는다. 표시 문구는 호출부가
 * `status`/`code`로 직접 고른다.
 */
export class ApiError extends Error {
  readonly status: number
  readonly code: string | null
  /**
   * 429 응답의 `Retry-After` 값(초). FMS가 I-7로 **rack3d 백오프용으로 일부러 추가**해 준 헤더다.
   *
   * FMS 조회 계열에 현재 레이트리밋은 없지만(§11-16), 프록시·게이트웨이가 끼거나 앞으로 제한이
   * 생기면 여전히 올 수 있는 응답이다. 서버가 "이만큼 기다리라"고 말했는데 원래 주기로 계속
   * 두드리는 것은 어떤 경우에도 옳지 않으므로 처리는 남긴다.
   */
  readonly retryAfterSeconds: number | null

  constructor(status: number, code: string | null, retryAfterSeconds: number | null = null) {
    super(`FMS API 오류 (HTTP ${status}${code ? ` ${code}` : ''})`)
    this.name = 'ApiError'
    this.status = status
    this.code = code
    this.retryAfterSeconds = retryAfterSeconds
  }
}

/** 요청 상한 시간. FMS가 응답을 물고 있을 때 화면이 영원히 "불러오는 중"으로 남지 않게 한다. */
const REQUEST_TIMEOUT_MS = 20_000

/** 타임아웃이 걸린 fetch. AbortController가 없으면 브라우저 기본(무한)에 맡겨진다. */
async function fetchWithTimeout(input: string, init: RequestInit): Promise<Response> {
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS)
  try {
    return await fetch(input, { ...init, signal: controller.signal })
  } finally {
    clearTimeout(timer)
  }
}

/**
 * 백오프 상한. FMS가 준 `Retry-After`를 따르되 **이 값 이상은 기다리지 않는다.**
 * 프록시·오설정이 큰 값(예: 86400)을 한 번만 흘려도 관제 화면이 하루 침묵하기 때문이다 —
 * 관제 화면에서 "조용한 정지"는 틀린 값만큼이나 위험하다.
 */
const MAX_RETRY_AFTER_SECONDS = 300

/**
 * `Retry-After`는 delta-seconds 또는 HTTP-date다(RFC 9110). 둘 다 받는다.
 * 해석 불가·음수면 null — 임의의 값을 지어내지 않는다. 유효한 값은 상한으로 잘라 돌려준다.
 */
function parseRetryAfter(response: Response): number | null {
  const raw = response.headers.get('Retry-After')
  if (!raw) return null
  const clamp = (seconds: number) => Math.min(MAX_RETRY_AFTER_SECONDS, Math.max(0, Math.round(seconds)))
  const seconds = Number(raw.trim())
  if (Number.isFinite(seconds)) return seconds >= 0 ? clamp(seconds) : null
  const at = Date.parse(raw)
  if (Number.isNaN(at)) return null
  return clamp((at - Date.now()) / 1000)
}

/** 네트워크 자체가 실패했을 때 쓰는 의사 상태 코드(HTTP 응답이 없는 경우). */
export const NETWORK_ERROR_STATUS = 0

let accessToken: string | null = null
/** 현재 액세스 토큰의 만료 시각(epoch ms). 토큰이 없거나 TTL을 모르면 null. */
let accessTokenExpiresAt: number | null = null
let sessionExpiredHandler: (() => void) | null = null
let passwordChangeRequiredHandler: (() => void) | null = null

/** 세션 계층(`session.ts`)이 만료·비밀번호 변경 요구를 구독한다. */
export function setAuthHandlers(handlers: {
  onSessionExpired: () => void
  onPasswordChangeRequired: () => void
}) {
  sessionExpiredHandler = handlers.onSessionExpired
  passwordChangeRequiredHandler = handlers.onPasswordChangeRequired
}

/** 메모리 토큰 즉시 파기 (C12 — 로그아웃·세션 만료). 선제 갱신 타이머도 함께 정리한다. */
export function clearAccessToken() {
  accessToken = null
  accessTokenExpiresAt = null
  stopProactiveRefresh()
}

// ── ① 선제 갱신 (§11-8 합의안) ───────────────────────────────────────────────
//
// FMS `TokenResponse.expiresInSeconds`(실측 900)를 써서 만료 전에 미리 refresh 한다.
// **정합성 장치가 아니라 401 왕복을 줄이는 최적화다** — ②(401 → refresh → 1회 재시도)가
// 이미 있어서, 만료된 채로 복귀해도 동작은 정상이다.
//
// ⚠️ FMS 프론트의 평이한 `setTimeout` 방식을 그대로 복제하지 않는다. rack3d에는 C11
//    (탭 비활성 시 폴링 중단)이 있어, 타이머를 그냥 걸면 **숨긴 탭에서도 15분마다 refresh가
//    나가** 폴링을 멈춘 의미가 줄고 탭을 여러 개 띄운 관제 PC에서 그만큼 배가된다.
//    그래서 타이머는 **탭이 보이는 동안에만** 걸고, 복귀 시 남은 수명이 임계 이하면 즉시 갱신한다.

/** 만료 이 시간 전에 갱신한다. 복귀 시 "즉시 갱신" 판정 임계값도 겸한다. */
const REFRESH_LEAD_MS = 60_000

/**
 * 예약 간격 바닥값.
 *
 * TTL이 짧게(또는 0에 가깝게) 내려오면 `expiresAt - lead`가 음수가 되어 타이머가 즉시
 * 발화하고, 그 refresh가 또 짧은 TTL을 주면 **refresh 폭주 루프**가 된다. 최소 간격을 둬서
 * 최악의 경우에도 이 주기를 넘지 않게 막는다.
 */
const REFRESH_MIN_DELAY_MS = 30_000

let refreshTimer: number | null = null
let visibilityListenerAttached = false

function clearRefreshTimer() {
  if (refreshTimer !== null) {
    window.clearTimeout(refreshTimer)
    refreshTimer = null
  }
}

/** 남은 수명(ms). TTL을 모르면 null — **모르는 것을 0이나 만료로 단정하지 않는다.** */
function remainingLifetimeMs(): number | null {
  if (accessTokenExpiresAt === null) return null
  return accessTokenExpiresAt - Date.now()
}

function scheduleProactiveRefresh() {
  clearRefreshTimer()
  if (!accessToken) return
  // C11 — 보이지 않는 탭에서는 예약하지 않는다. 복귀 시 아래 리스너가 다시 건다.
  if (typeof document !== 'undefined' && document.visibilityState === 'hidden') return
  const remaining = remainingLifetimeMs()
  if (remaining === null) return // TTL 미상 — 선제 갱신을 포기하고 ②에 맡긴다.
  const delay = Math.max(REFRESH_MIN_DELAY_MS, remaining - REFRESH_LEAD_MS)
  refreshTimer = window.setTimeout(() => {
    refreshTimer = null
    // 실패해도 세션을 파기하지 않는다 — 판단은 ②(실제 요청의 401)에 맡긴다.
    // 여기서 세션을 끊으면 일시적 네트워크 단절만으로 화면이 로그인으로 튕긴다.
    void tryRefresh()
  }, delay)
}

function handleTokenVisibilityChange() {
  if (document.visibilityState === 'hidden') {
    clearRefreshTimer()
    return
  }
  const remaining = remainingLifetimeMs()
  // 숨어 있는 동안 만료가 가까워졌으면 즉시 갱신한다(다음 폴링의 401 왕복을 줄인다).
  if (remaining !== null && remaining <= REFRESH_LEAD_MS) {
    void tryRefresh() // 성공하면 tryRefresh가 다시 예약한다.
    return
  }
  scheduleProactiveRefresh()
}

function startProactiveRefresh() {
  if (typeof document === 'undefined') return
  if (!visibilityListenerAttached) {
    document.addEventListener('visibilitychange', handleTokenVisibilityChange)
    visibilityListenerAttached = true
  }
  scheduleProactiveRefresh()
}

/** C12 — 세션이 끝나면 타이머와 리스너를 모두 걷어낸다. */
function stopProactiveRefresh() {
  clearRefreshTimer()
  if (visibilityListenerAttached && typeof document !== 'undefined') {
    document.removeEventListener('visibilitychange', handleTokenVisibilityChange)
    visibilityListenerAttached = false
  }
}

/**
 * refresh 단일 비행(single-flight) — 동시 401에서 중복 갱신 방지 (C2).
 *
 * 위젯 여러 개가 같은 순간에 401을 받으면 refresh가 그 수만큼 나간다. 하나면 될 일을 여러 번
 * 하는 것이라 레이트리밋과 무관하게 낭비이고, 서버가 리프레시 토큰을 회전시키는 구현이면
 * 경쟁 상태로 서로의 토큰을 무효화할 수도 있다.
 */
let refreshInFlight: Promise<RefreshOutcome | null> | null = null

/**
 * 리프레시 쿠키로 세션 복원/갱신. 실패 시 null.
 *
 * 본문 없이 POST한다 — 같은 오리진이라 `SameSite=Strict` 쿠키가 자동으로 실린다.
 */
export async function tryRefresh(): Promise<RefreshOutcome | null> {
  if (!refreshInFlight) {
    refreshInFlight = (async () => {
      try {
        const response = await fetchWithTimeout(`${BASE_URL}/auth/refresh`, { method: 'POST' })
        if (!response.ok) return null
        const token = (await response.json()) as TokenResponse
        accessToken = token.accessToken
        // TTL이 없거나 이상한 값이면 만료 시각을 **지어내지 않는다**(null → 선제 갱신 포기).
        accessTokenExpiresAt = Number.isFinite(token.expiresInSeconds) && token.expiresInSeconds > 0
          ? Date.now() + token.expiresInSeconds * 1000
          : null
        startProactiveRefresh()
        return { mustChangePassword: token.mustChangePassword }
      } catch {
        // 네트워크 단절 — 세션이 살아 있는지 알 수 없으므로 실패로 처리한다.
        return null
      } finally {
        refreshInFlight = null
      }
    })()
  }
  return refreshInFlight
}

/** 401 시 refresh 재시도를 하지 않는 경로(인증 플로우 자체) — C3. */
const NO_RETRY_PATHS = ['/auth/login', '/auth/otp/', '/auth/refresh', '/auth/logout']

function isRetryablePath(path: string): boolean {
  return !NO_RETRY_PATHS.some((prefix) => path.startsWith(prefix))
}

async function rawRequest(method: string, path: string): Promise<Response> {
  const headers: Record<string, string> = {}
  if (accessToken) headers['Authorization'] = `Bearer ${accessToken}`
  try {
    return await fetchWithTimeout(`${BASE_URL}${path}`, { method, headers })
  } catch (error) {
    // fetch가 던지는 것은 네트워크 단절 또는 우리가 건 타임아웃뿐이다.
    // 원문 대신 고정 코드로 바꿔 올린다(C8).
    const timedOut = error instanceof DOMException && error.name === 'AbortError'
    throw new ApiError(NETWORK_ERROR_STATUS, timedOut ? 'TIMEOUT' : 'NETWORK_ERROR')
  }
}

/** FMS `ErrorResponse.code`만 뽑아온다. 비JSON 응답이면 null. */
async function readErrorCode(response: Response): Promise<string | null> {
  try {
    const body = (await response.json()) as { code?: unknown }
    return typeof body.code === 'string' ? body.code : null
  } catch {
    return null
  }
}

async function request<T>(method: string, path: string): Promise<T> {
  let response = await rawRequest(method, path)

  if (response.status === 401 && isRetryablePath(path)) {
    const refreshed = await tryRefresh()
    if (refreshed) {
      // 재시도는 1회뿐. 갱신한 토큰으로도 401이면 세션이 실제로 끝난 것이다 —
      // 그냥 던지면 폴링이 30초마다 (요청+refresh+재시도) 3회를 무기한 반복하는데,
      // **그 반복은 무엇도 고치지 못한다**(끝난 세션은 재시도로 살아나지 않는다).
      // 여기서 세션을 파기해 폴링까지 멈춘다(C2·C12).
      // ⚠️ 근거는 레이트리밋이 아니다 — 조회·refresh 계열에 제한은 없다(§11-16).
      response = await rawRequest(method, path)
      if (response.status === 401) {
        clearAccessToken()
        sessionExpiredHandler?.()
      }
    } else {
      clearAccessToken()
      sessionExpiredHandler?.()
    }
  }

  if (!response.ok) {
    const code = await readErrorCode(response)
    if (response.status === 403 && code === 'PASSWORD_CHANGE_REQUIRED') {
      // C4 — rack3d가 자체 처리하지 않고 FMS 비밀번호 변경 화면으로 넘긴다.
      passwordChangeRequiredHandler?.()
    }
    throw new ApiError(response.status, code, parseRetryAfter(response))
  }

  if (response.status === 204) return undefined as T
  return (await response.json()) as T
}

export const api = {
  get: <T>(path: string) => request<T>('GET', path),
}

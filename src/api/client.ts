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
   * 429 응답의 `Retry-After` 값(초). FMS가 I-7로 **rack3d 백오프용으로 일부러 추가**해 준 헤더다 —
   * 무시하고 원래 주기로 계속 두드리면 레이트리밋을 더 오래 물게 된다.
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

/** 메모리 토큰 즉시 파기 (C12 — 로그아웃·세션 만료). */
export function clearAccessToken() {
  accessToken = null
}

/** refresh 단일 비행(single-flight) — 동시 401에서 중복 갱신 방지 (C2, R6). */
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
      // 그냥 던지면 폴링이 30초마다 (요청+refresh+재시도) 3회를 무기한 반복해
      // FMS 레이트리밋을 소진한다(R6). 여기서 세션을 파기해 폴링까지 멈춘다(C2·C12).
      response = await rawRequest(method, path)
      if (response.status === 401) {
        accessToken = null
        sessionExpiredHandler?.()
      }
    } else {
      accessToken = null
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

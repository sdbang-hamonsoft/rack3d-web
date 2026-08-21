/**
 * 세션 부트스트랩 + 세션 파기 처리.
 *
 * rack3d에는 **로그인 화면이 없다**(결정 2-a). FMS는 이메일 OTP MFA·계정잠금·비밀번호 만료를
 * 이미 갖고 있어 재구현이 위험하고 무의미하다. rack3d는 같은 오리진의 리프레시 쿠키로
 * 세션을 복원하고, 안 되면 FMS 로그인 화면으로 넘긴다.
 */

import { ApiError, clearAccessToken, setAuthHandlers, tryRefresh } from './client'
import { fetchMe } from './fms'
import type { MeResponse } from './types'

/** FMS 프론트 라우트(같은 오리진) — `netis-fms/frontend/src/router.tsx`. */
const FMS_LOGIN_PATH = '/login'
const FMS_PASSWORD_CHANGE_PATH = '/password-change'

/**
 * 로그인 이동 시 복귀 경로를 `?redirect=`로 얹을지 여부.
 *
 * 2026-08-21 기준 FMS 로그인 화면은 react-router `location.state.from`만 읽어
 * `?redirect=`를 무시한다(`LoginPage.tsx:36`). 다만 netis-fms가 I-3 회신에서
 * **쿼리 파라미터 지원 추가에 착수**했다(상대 경로만 허용, `//`·절대 URL 차단) —
 * 지금 붙여도 무시될 뿐 해가 없고, 배포되는 즉시 복귀 동작이 살아난다.
 * 문제가 되면 이 상수만 false로 바꾸면 `/login`으로만 이동한다.
 */
const APPEND_REDIRECT_PARAM = true

/**
 * 사이트 내부 상대 경로만 허용한다 — `/`로 시작하되 `//`(프로토콜 상대 URL = 외부 오리진)는 막는다.
 * FMS 쪽에도 같은 검증이 있지만, **복귀 경로를 만드는 쪽에서 먼저 막는다**(오픈 리다이렉트는
 * 검증을 상대에게 미루는 순간 생긴다).
 */
function isInternalPath(path: string): boolean {
  return /^\/(?!\/)/.test(path)
}

/** 지금 보고 있는 경로(rack3d base 포함). */
function currentRelativePath(): string {
  return window.location.pathname + window.location.search
}

export function fmsLoginUrl(): string {
  if (!APPEND_REDIRECT_PARAM) return FMS_LOGIN_PATH
  const redirect = currentRelativePath()
  if (!isInternalPath(redirect)) return FMS_LOGIN_PATH
  return `${FMS_LOGIN_PATH}?redirect=${encodeURIComponent(redirect)}`
}

// ── 폴링 타이머 레지스트리 (C11·C12) ─────────────────────────────────────────

const pollingStops = new Set<() => void>()

/**
 * 폴링 훅이 자기 정지 함수를 등록한다. 세션이 끊기면 한 번에 전부 멈춘다 —
 * 만료된 세션으로 30초마다 401을 쏘면 FMS 레이트리밋(IP 30회/분)을 소진해
 * 같은 NAT의 다른 사용자까지 막을 수 있다(R6).
 */
export function registerPollingStop(stop: () => void): () => void {
  pollingStops.add(stop)
  return () => {
    pollingStops.delete(stop)
  }
}

export function stopAllPolling() {
  const stops = [...pollingStops]
  pollingStops.clear()
  stops.forEach((stop) => stop())
}

// ── 세션 파기 ────────────────────────────────────────────────────────────────

type SessionExpiredListener = () => void

let sessionExpiredListener: SessionExpiredListener | null = null
let passwordChangeListener: SessionExpiredListener | null = null
/** 부트스트랩이 한 번이라도 성공했는가 — 최초 진입과 세션 만료를 구분한다. */
let sessionEstablished = false
let navigatingAway = false

/**
 * 다른 화면으로 실제 이동한다. 이동은 **한 번만** 한다 —
 * FMS 라우트가 아직 없는 환경(예: vite dev 서버)에서는 이동한 경로도 rack3d SPA로
 * fallback 되므로, 재이동을 막지 않으면 무한 루프가 된다.
 */
function navigateTo(url: string) {
  if (navigatingAway) return
  navigatingAway = true
  window.location.href = url
}

/**
 * 세션 파기 처리: 메모리 토큰 파기 → 폴링 전부 정지 → 화면 전환.
 *
 * 최초 부트스트랩 실패는 **이동하지 않고 안내 화면을 띄운다**(사용자가 버튼으로 이동).
 * 자동 이동은 세션이 한 번 살아 있었던 경우로 제한한다 — 페이지 로드 직후의 자동 이동은
 * FMS 로그인 라우트가 없는 환경에서 리다이렉트 루프를 만든다.
 */
export function handleSessionExpired() {
  clearAccessToken()
  stopAllPolling()
  if (sessionEstablished) {
    sessionEstablished = false
    navigateTo(fmsLoginUrl())
    return
  }
  sessionExpiredListener?.()
}

/**
 * C4 — 비밀번호 변경 강제는 FMS 화면이 처리한다. rack3d는 넘기기만 한다.
 *
 * 세션 만료와 **같은 규칙**을 쓴다: 자동 이동은 세션이 한 번 살아 있었던 경우로만 제한한다.
 * 부트스트랩에서 곧장 이동하면, FMS 라우트가 없는 환경(vite dev 등)에서 `/password-change`가
 * rack3d SPA로 fallback → 부트스트랩 재실행 → 다시 이동으로 루프가 된다.
 */
export function handlePasswordChangeRequired() {
  clearAccessToken()
  stopAllPolling()
  if (sessionEstablished) {
    sessionEstablished = false
    navigateTo(FMS_PASSWORD_CHANGE_PATH)
    return
  }
  passwordChangeListener?.()
}

/** 사용자가 안내 화면에서 "로그인하러 가기"를 눌렀을 때. */
export function goToFmsLogin() {
  navigatingAway = false
  navigateTo(fmsLoginUrl())
}

/** 사용자가 안내 화면에서 "비밀번호 변경하러 가기"를 눌렀을 때. */
export function goToFmsPasswordChange() {
  navigatingAway = false
  navigateTo(FMS_PASSWORD_CHANGE_PATH)
}

setAuthHandlers({
  onSessionExpired: handleSessionExpired,
  onPasswordChangeRequired: handlePasswordChangeRequired,
})

// ── 부트스트랩 ───────────────────────────────────────────────────────────────

export type BootstrapResult =
  | { status: 'authenticated'; me: MeResponse }
  | { status: 'unauthenticated' }
  | { status: 'password-change' }

/**
 * 앱 시작 시 1회: `POST /api/auth/refresh` → 성공하면 `GET /api/auth/me`.
 *
 * `mustChangePassword`면 rack3d 화면을 열지 않고 FMS 비밀번호 변경 화면으로 넘긴다(C4) —
 * 어차피 FMS가 모든 보호 API를 403으로 막고 있어 rack3d에서 할 수 있는 일이 없다.
 */
export async function bootstrapSession(handlers: {
  onSessionExpired: SessionExpiredListener
  onPasswordChangeRequired: SessionExpiredListener
}): Promise<BootstrapResult> {
  sessionExpiredListener = handlers.onSessionExpired
  passwordChangeListener = handlers.onPasswordChangeRequired

  const token = await tryRefresh()
  if (!token) return { status: 'unauthenticated' }

  if (token.mustChangePassword) {
    clearAccessToken()
    return { status: 'password-change' }
  }

  try {
    const me = await fetchMe()
    if (me.mustChangePassword) {
      clearAccessToken()
      return { status: 'password-change' }
    }
    sessionEstablished = true
    return { status: 'authenticated', me }
  } catch (error) {
    clearAccessToken()
    // refresh는 mustChangePassword=false였는데 곧바로 이은 /me가 403을 주는 경우가 있다.
    // 이때 client가 이미 passwordChangeListener를 호출해 화면을 'password-change'로 바꿔 놓는데,
    // 여기서 'unauthenticated'를 돌려주면 호출부가 그걸 'expired'로 덮어쓴다.
    if (error instanceof ApiError && error.code === 'PASSWORD_CHANGE_REQUIRED') {
      return { status: 'password-change' }
    }
    // 그 밖의 /me 실패는 세션 없음과 같게 다룬다. 원인 문자열은 화면에 싣지 않는다(C8).
    return { status: 'unauthenticated' }
  }
}

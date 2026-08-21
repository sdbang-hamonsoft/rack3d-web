/**
 * FMS 데이터 폴링 훅.
 *
 * 실시간 갱신 수단은 폴링으로 확정돼 있다(결정 4-a) — FMS `RealtimeHub`가 푸시하는 것은
 * `rawEvent`/`ticket`/`accessTag` 3종뿐이라 온도·전력·랙 집계는 SSE로 오지 않는다.
 *
 * 규약:
 * - C11: 주기 하한(랙 목록 ≥30초)을 호출부가 정하고, **이 훅이 그 하한을 강제한다** —
 *   탭 복귀는 남은 시간만큼 미뤄 예약한다. 사용자가 누르는 재시도만 예외로 백오프를 넘되,
 *   {@link MANUAL_RETRY_COOLDOWN_MS} 쿨다운이 걸려 연타가 요청 폭주가 되지 않는다.
 * - C11: 탭이 비활성이면 폴링을 멈춘다. 복귀 시 하한을 지키면서 재개한다.
 * - C12: 세션이 끊기면 `session.stopAllPolling()`이 여기 등록된 정지 함수를 전부 호출한다.
 * - 요청 시퀀스: 겹쳐 시작된 요청 중 **가장 마지막에 시작한 것의 응답만** 반영한다.
 *   (탭 복귀·수동 새로고침으로 주기 밖 요청이 끼어들면 먼저 시작한 느린 응답이 나중에
 *   도착해 최신 결과를 덮어쓸 수 있다.)
 */

import { useCallback, useEffect, useRef, useState } from 'react'
import { registerPollingStop } from '../api/session'
import { describeFailure, type ApiFailure } from '../api/fms'

type PolledState<T> = {
  data: T | null
  failure: ApiFailure | null
  loading: boolean
  lastUpdatedAt: Date | null
  /** 다음 자동 갱신 예정 시각. 카운트다운 표시에 쓴다. */
  nextAttemptAt: Date | null
}

export type PolledResource<T> = PolledState<T> & {
  /** 하한·백오프를 지키는 갱신 요청(탭 복귀 등). */
  refresh: () => void
  /**
   * 사용자가 명시적으로 누른 즉시 재시도.
   *
   * **백오프는 무시하되 연타는 막는다.** 백오프를 못 넘으면 길게 잡힌 재시도 대기에서
   * F5 말고 복구 수단이 없고, 하한까지 통째로 지우면 즉답 실패(404·429)에서 연타가
   * 그대로 요청 폭주가 된다 — FMS 레이트리밋(IP 30회/분)을 소진하면 같은 NAT의 다른
   * 사용자까지 막힌다(R6). 그래서 {@link MANUAL_RETRY_COOLDOWN_MS} 간격만 허용한다.
   */
  retryNow: () => void
}

/**
 * 수동 재시도 최소 간격.
 *
 * 자동 폴링이 30초이므로 5초면 사람이 계속 눌러도 분당 12회가 상한이다 —
 * FMS 레이트리밋(30회/분)의 절반 이하로, 여러 탭이 겹쳐도 여유가 남는다.
 * 반대로 5초는 "고장 났나?" 하고 다시 눌러보는 사람에게 답답하지 않은 정도다.
 */
export const MANUAL_RETRY_COOLDOWN_MS = 5_000

/**
 * @param fetcher 호출부에서 `useCallback`/`useMemo`로 감싸 넘길 것 — 이 함수의 동일성이
 *                폴링 주기를 다시 시작하는 기준이다. `null`이면 폴링하지 않는다(전산실 미선택 등).
 * @param intervalMs 폴링 주기(ms). 두 갱신 사이의 최소 간격이기도 하다.
 */
export function usePolledResource<T>(
  fetcher: (() => Promise<T>) | null,
  intervalMs: number,
): PolledResource<T> {
  const idleState: PolledState<T> = {
    data: null, failure: null, loading: false, lastUpdatedAt: null, nextAttemptAt: null,
  }
  const [state, setState] = useState<PolledState<T>>(
    fetcher ? { ...idleState, loading: true } : idleState,
  )

  // 대상이 바뀌면(전산실 전환 등) 이전 대상의 데이터를 즉시 버린다.
  // effect 안에서 setState 하면 렌더가 연쇄되므로, React가 권장하는 "렌더 중 상태 조정" 패턴을 쓴다.
  //
  // ⚠️ fetcher는 **함수**다. `useState(fetcher)` / `setTracked(fetcher)`처럼 그대로 넘기면
  //    React가 지연 초기화·업데이터 함수로 보고 **호출해 버린다**(반환된 Promise가 상태가 되고,
  //    비교가 영원히 불일치해 무한 렌더 + 무한 요청). 반드시 객체로 감싸서 넘긴다.
  const [tracked, setTracked] = useState<{ fetcher: typeof fetcher }>(() => ({ fetcher }))
  if (tracked.fetcher !== fetcher) {
    setTracked({ fetcher })
    setState(fetcher ? { ...idleState, loading: true } : idleState)
  }

  /** 현재 주기의 "지금 갱신" 함수 — `refresh`가 이 참조를 통해 호출한다. */
  const runRef = useRef<() => void>(() => {})
  /** 백오프를 넘되 쿨다운은 지키는 사용자 재시도 — `retryNow`가 이 참조를 통해 호출한다. */
  const forceRunRef = useRef<() => void>(() => {})

  useEffect(() => {
    if (!fetcher) {
      runRef.current = () => {}
      forceRunRef.current = () => {}
      return
    }

    let cancelled = false
    let timer: number | null = null
    /** 시작한 요청의 일련번호. 응답이 최신 번호가 아니면 폐기한다. */
    let sequence = 0
    let latestSequence = 0
    /** 마지막으로 **요청을 시작한** 시각 — 하한 계산 기준(응답 지연에 영향받지 않게). */
    let lastStartedAt = 0
    /** 429 `Retry-After`로 정해진 재개 시각(epoch ms). 0이면 백오프 없음. */
    let backoffUntil = 0

    const clearTimer = () => {
      if (timer !== null) {
        window.clearTimeout(timer)
        timer = null
      }
    }

    /** 다음 실행까지 남은 시간 — 폴링 하한과 429 백오프 중 **더 긴 쪽**. */
    const remainingDelay = () => {
      const sinceLastStart = Math.max(0, intervalMs - (Date.now() - lastStartedAt))
      const untilBackoffEnds = Math.max(0, backoffUntil - Date.now())
      return Math.max(sinceLastStart, untilBackoffEnds)
    }

    /** 하한·백오프를 지켜 다음 실행을 예약한다. */
    const scheduleNext = () => {
      clearTimer()
      // C11 — 보이지 않는 탭에서는 예약하지 않는다. 복귀 시 visibilitychange가 다시 돌린다.
      if (cancelled || document.visibilityState === 'hidden') {
        setState((previous) => ({ ...previous, nextAttemptAt: null }))
        return
      }
      const delay = remainingDelay()
      setState((previous) => ({ ...previous, nextAttemptAt: new Date(Date.now() + delay) }))
      timer = window.setTimeout(() => void run(), delay)
    }

    const run = async () => {
      clearTimer()
      sequence += 1
      const mySequence = sequence
      latestSequence = mySequence
      lastStartedAt = Date.now()
      try {
        const data = await fetcher()
        if (cancelled || mySequence !== latestSequence) return
        // 성공하면 백오프를 해제한다 — 서버가 회복했는데 옛 Retry-After를 계속 붙들고 있으면
        // 정상 복구 후에도 화면이 계속 멈춰 있다.
        backoffUntil = 0
        setState({ data, failure: null, loading: false, lastUpdatedAt: new Date(), nextAttemptAt: null })
      } catch (error) {
        if (cancelled || mySequence !== latestSequence) return
        const failure = describeFailure(error)
        // 429 Retry-After를 그대로 따른다(I-7). 이걸 무시하면 레이트리밋을 더 오래 물게 된다.
        if (failure.retryAfterMs !== null) backoffUntil = Date.now() + failure.retryAfterMs
        // 실패해도 직전 데이터는 남긴다 — 화면이 갑자기 비는 것보다 "갱신 실패" 표시가 낫다.
        setState((previous) => ({ ...previous, failure, loading: false }))
      } finally {
        // 늦게 도착한 응답이 스케줄을 흔들지 않게, 최신 요청만 다음 주기를 잡는다.
        if (mySequence === latestSequence) scheduleNext()
      }
    }

    /**
     * 자동 갱신 요청(탭 복귀). 하한이나 429 백오프가 남아 있으면 실행하지 않고 남은 시간만
     * 예약한다 — 알트탭을 반복해도 30초 하한(C11)과 백오프가 무력화되지 않는다.
     * (사용자가 누르는 재시도는 {@link forceRun} 쪽이며, 백오프만 넘고 쿨다운은 지킨다.)
     */
    const requestRun = () => {
      if (cancelled) return
      if (remainingDelay() === 0) {
        void run()
        return
      }
      scheduleNext()
    }

    /**
     * 사용자 재시도 — 백오프는 지우되 **주기 하한 전체를 지우지는 않는다.**
     * 직전 요청이 쿨다운 안이면 아무것도 하지 않는다(이미 잡힌 예약은 그대로 유지된다).
     */
    const forceRun = () => {
      if (cancelled) return
      if (Date.now() - lastStartedAt < MANUAL_RETRY_COOLDOWN_MS) return
      backoffUntil = 0
      void run()
    }

    const handleVisibilityChange = () => {
      if (document.visibilityState === 'visible') requestRun()
      else clearTimer()
    }

    const stop = () => {
      cancelled = true
      clearTimer()
    }

    const unregister = registerPollingStop(stop)
    document.addEventListener('visibilitychange', handleVisibilityChange)
    runRef.current = requestRun
    forceRunRef.current = forceRun

    void run()

    return () => {
      stop()
      unregister()
      document.removeEventListener('visibilitychange', handleVisibilityChange)
    }
  }, [fetcher, intervalMs])

  const refresh = useCallback(() => runRef.current(), [])
  const retryNow = useCallback(() => forceRunRef.current(), [])

  return { ...state, refresh, retryNow }
}

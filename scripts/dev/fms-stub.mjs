/**
 * netis-fms 개발용 스텁 서버 (의존성 0, node:http만 사용).
 *
 * 목적: FMS 개발 계정 없이 **로그인 이후 화면 전체**를 실제로 렌더해 검증한다.
 * 실행:
 *   node scripts/dev/fms-stub.mjs
 *   VITE_FMS_ORIGIN=http://localhost:8777 npm run dev
 *
 * ⚠️ 이것은 **문서(E19 §I·FMS DTO)대로 만든 모형**이지 실제 FMS가 아니다.
 *    여기서 통과한다고 실제 계약이 맞다는 뜻이 아니다 — 계정이 생기면 실응답과 대조할 것.
 *
 * 픽스처는 C6(가짜 0 금지)를 가르는 네 경우를 모두 담는다:
 *   A-01 센서 있음(정상값) / A-02 센서 있음(낮은 값)
 *   A-03 센서 없음 → temp·humidity·powerKw = null  → 화면에 `—`
 *   A-05 **참인 0** → temp·humidity·powerKw = 0     → 화면에 `0`  ← null과 반드시 갈려야 한다
 *   A-04 랙 크기 미설정(rackUnits = null) + 통신두절(stale)
 */
import { createServer } from 'node:http'

const PORT = Number(process.env.PORT ?? 8777)
const SCENARIO = process.env.SCENARIO ?? 'ok'
// ok           정상
// 429          racks가 계속 429 + Retry-After: 45 → 백오프 주기 확인
// 429-once     첫 racks만 429 + Retry-After: 86400 → 상한(300s) 클램프·수동 복구 확인
// hang         sidebar 무응답 → 로비 로딩 타임아웃 확인
// racks-hang   racks 무응답 → 씬 상태·LIVE 뱃지 타임아웃 전환 확인
// scope-denied racks 404 → 스코프 밖 "권한 없음" 수렴 확인

const rack = (o) => ({
  code: null, rackUnits: 42, assetCount: 0, occupiedUnits: 0, temp: null, humidity: null,
  powerKw: null, severity: 'NORMAL', collectedAt: null, stale: false, categoryCounts: {}, ...o,
})

const racks = [
  rack({ locationId: 11, name: 'A-01', code: 'A01', occupiedUnits: 20, assetCount: 9, temp: 32.4, humidity: 44.8, powerKw: 4.2, severity: 'CRITICAL', collectedAt: '2026-08-21T08:00:00Z', categoryCounts: { SERVER: 9 } }),
  rack({ locationId: 12, name: 'A-02', occupiedUnits: 8, assetCount: 3, temp: 21.1, humidity: 41.2, powerKw: 1.1, collectedAt: '2026-08-21T08:00:00Z', categoryCounts: { SERVER: 3 } }),
  rack({ locationId: 13, name: 'A-03', occupiedUnits: 0, assetCount: 0 }), // 센서 없음 → null
  rack({ locationId: 14, name: 'A-04', rackUnits: null, occupiedUnits: 5, assetCount: 2, severity: 'MAJOR', stale: true, collectedAt: '2026-08-21T07:55:00Z', categoryCounts: { NETWORK: 2 } }),
  // 참인 0 — null과 반드시 다르게 표시돼야 한다(전원이 꺼진 랙, 0℃ 냉동 구역 등)
  rack({ locationId: 15, name: 'A-05', occupiedUnits: 2, assetCount: 1, temp: 0, humidity: 0, powerKw: 0, collectedAt: '2026-08-21T08:00:00Z' }),
]

const zone = {
  id: 101, layer: 'ZONE', name: '서울 메인 전산실', code: 'SEL-01', sortOrder: 1, totalAssetCount: 15,
  children: racks.map((r, i) => ({ id: r.locationId, layer: 'RACK', name: r.name, code: r.code, sortOrder: i, children: [] })),
}

let blockedOnce = false
const log = []
createServer((req, res) => {
  const auth = req.headers.authorization ?? null
  log.push(`${Date.now()} ${req.method} ${req.url} auth=${auth ? 'Bearer ***' : 'none'}`)
  const json = (code, body, headers = {}) => {
    res.writeHead(code, { 'Content-Type': 'application/json', ...headers })
    res.end(JSON.stringify(body))
  }

  if (req.url === '/api/auth/refresh' && req.method === 'POST') {
    return json(200, { accessToken: 'stub-access-token', expiresInSeconds: 900, mustChangePassword: false, user: { username: 'dev', name: '개발자' } })
  }
  // 보호 API는 Bearer 없으면 401 — 토큰이 실제로 실리는지 검증한다(C1 흐름).
  if (!auth) return json(401, { code: 'UNAUTHORIZED', message: '인증이 필요합니다.' })

  if (req.url === '/api/auth/me') {
    return json(200, {
      username: 'dev', name: '개발자', department: '인프라', email: 'dev@example.com',
      mustChangePassword: false, roleGroupName: '운영',
      permissions: [
        { menu: 'ASSET', read: true, write: false, control: false },
        { menu: 'PERFORMANCE', read: true, write: false, control: false },
      ],
    })
  }
  if (req.url === '/api/locations/sidebar') {
    if (SCENARIO === 'hang') return // 응답하지 않는다 — 클라이언트 타임아웃 확인용
    return json(200, {
      allLocations: true,
      roots: [{ id: 1, layer: 'BUILDING', name: '본사', code: 'HQ', sortOrder: 0, totalAssetCount: 15,
        children: [{ id: 10, layer: 'FLOOR', name: '3층', code: null, sortOrder: 0, totalAssetCount: 15, children: [zone] }] }],
    })
  }
  if (req.url === '/api/zones/101/racks') {
    // 스코프 밖은 FMS가 racks에서 404로 은닉한다 — rack3d는 403과 같은 UI로 수렴해야 한다(R7).
    if (SCENARIO === 'scope-denied') return json(404, { code: 'NOT_FOUND', message: '없음' })
    if (SCENARIO === 'racks-hang') return // 응답하지 않는다
    if (SCENARIO === '429') return json(429, { code: 'RATE_LIMITED', message: 'too many' }, { 'Retry-After': '45' })
    if (SCENARIO === '429-once') {
      if (!blockedOnce) { blockedOnce = true; return json(429, { code: 'RATE_LIMITED', message: 'too many' }, { 'Retry-After': '86400' }) }
      return json(200, racks)
    }
    return json(200, racks)
  }
  return json(404, { code: 'NOT_FOUND', message: '없음' })
}).listen(PORT, () => console.log(`fms-stub on :${PORT} (SCENARIO=${SCENARIO})`))

process.on('SIGTERM', () => { console.log('\n--- 요청 로그 ---\n' + log.join('\n')); process.exit(0) })

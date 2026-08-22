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
// umap-fail   ZONE u맵 500 → "불러오지 못했습니다" + 상단 LIVE·구조 미갱신 확인
// umap-hang    ZONE u맵 무응답 → 20초 타임아웃 뒤 실패 전환 확인
// umap-empty   ZONE u맵 200 [] → 랙은 있는데 항목이 없다. "장비 0대"로 단정하지 않는지 확인
// umap-partial A-01만 응답에서 누락 → "netis-fms가 이 랙의 U 배치를 반환하지 않았습니다" 확인
// category-missing  A-02 categoryCounts 필드 부재(assetCount 3) → "랙 내 자산"이 0이 아니라 `—`,
//                   "U 미배정 -3대" 같은 음수가 안 나오는지 확인

/** 액세스 토큰 수명(초). 선제 갱신 타이머를 짧게 관측할 때만 줄인다(실측 기본 900). */
const TOKEN_TTL = Number(process.env.TOKEN_TTL ?? 900)

const rack = (o) => ({
  code: null, rackUnits: 42, assetCount: 0, occupiedUnits: 0, temp: null, humidity: null,
  powerKw: null, severity: 'NORMAL', collectedAt: null, stale: false, categoryCounts: {}, ...o,
})

const racks = [
  rack({ locationId: 11, name: 'A-01', code: 'A01', occupiedUnits: 20, assetCount: 9, temp: 32.4, humidity: 44.8, powerKw: 4.2, severity: 'CRITICAL', collectedAt: '2026-08-21T08:00:00Z', categoryCounts: { SERVER: 8, NETWORK: 1, SENSOR: 1 } }), // 센서 1대는 U 미배정 → assetCount(9)와 합(10)이 다르다
  rack({ locationId: 12, name: 'A-02', occupiedUnits: 8, assetCount: 3, temp: 21.1, humidity: 41.2, powerKw: 1.1, collectedAt: '2026-08-21T08:00:00Z', categoryCounts: { SERVER: 3 } }),
  rack({ locationId: 13, name: 'A-03', occupiedUnits: 0, assetCount: 0 }), // 센서 없음 → null
  rack({ locationId: 14, name: 'A-04', rackUnits: null, occupiedUnits: 5, assetCount: 2, severity: 'MAJOR', stale: true, collectedAt: '2026-08-21T07:55:00Z', categoryCounts: { NETWORK: 2 } }),
  // 참인 0 — null과 반드시 다르게 표시돼야 한다(전원이 꺼진 랙, 0℃ 냉동 구역 등)
  rack({ locationId: 15, name: 'A-05', occupiedUnits: 2, assetCount: 1, temp: 0, humidity: 0, powerKw: 0, collectedAt: '2026-08-21T08:00:00Z', categoryCounts: { SERVER: 1 } }),
]

/**
 * 랙 u맵 픽스처 — `GET /api/racks/{id}/u-map`.
 *
 * FMS 계약대로 **U가 배정된 활성 자산만** 담는다(§11-11 Q1). 그래서 자산 수는
 * `RackSummary.assetCount`와 같고, `categoryCounts` 합(랙 내 전체)보다 작을 수 있다.
 * A-01은 **assetCount 9 vs categoryCounts 합 10**(문짝 센서 1대가 U 미배정) — 실 FMS 랙 17과 같은 케이스다.
 *
 * 제조사는 일부러 섞었다 — Dell/HPE/Cisco(우리 GLB 3종)·Synology(미보유)·null(미등록).
 * **null 필드는 화면에서 `—`로 나와야 한다**(지어내면 안 된다, C6·C7).
 */
const asset = (o) => ({
  id: 0, assetCode: 'STUB-000', name: '장비', category: 'SERVER', monitoringType: null,
  manufacturer: null, modelName: null, serialNo: null, spec: null, ip: null,
  lifecycleStatus: 'OPERATION', hasFront: false, hasRear: false, ...o,
})

const uMaps = {
  // A-01 — 9대 / 20U. 제조사 3사 + Synology + null 혼재.
  11: [
    asset({ id: 101, assetCode: 'STUB-A01-1', name: 'DB 서버 #1', manufacturer: 'Dell', modelName: 'PowerEdge R750', serialNo: 'SN-D-1', ip: '10.0.0.11', rackStartU: 19, rackEndU: 20, hasFront: true, hasRear: true }),
    asset({ id: 102, assetCode: 'STUB-A01-2', name: 'DB 서버 #2', manufacturer: 'HPE', modelName: 'ProLiant DL380', serialNo: 'SN-H-2', ip: '10.0.0.12', rackStartU: 17, rackEndU: 18 }),
    asset({ id: 103, assetCode: 'STUB-A01-3', name: '코어 스위치', category: 'NETWORK', manufacturer: 'Cisco', modelName: 'Catalyst 9300', ip: '10.0.0.13', rackStartU: 16, rackEndU: 16 }),
    asset({ id: 104, assetCode: 'STUB-A01-4', name: '스토리지 어레이', manufacturer: 'Synology', modelName: 'RS4021xs+', rackStartU: 12, rackEndU: 15 }),
    asset({ id: 105, assetCode: 'STUB-A01-5', name: '제조사 미등록 서버', rackStartU: 10, rackEndU: 11 }),
    asset({ id: 106, assetCode: 'STUB-A01-6', name: '워커 #1', manufacturer: 'Dell', modelName: 'PowerEdge R650', rackStartU: 9, rackEndU: 9 }),
    asset({ id: 107, assetCode: 'STUB-A01-7', name: '워커 #2', manufacturer: 'Dell', modelName: 'PowerEdge R650', rackStartU: 8, rackEndU: 8 }),
    asset({ id: 108, assetCode: 'STUB-A01-8', name: '백업 노드', manufacturer: 'HPE', modelName: 'ProLiant DL360', rackStartU: 5, rackEndU: 6 }),
    asset({ id: 109, assetCode: 'STUB-A01-9', name: 'KVM 콘솔', category: 'ETC', rackStartU: 1, rackEndU: 4 }),
  ],
  // A-02 — 3대 / 8U
  12: [
    asset({ id: 121, assetCode: 'STUB-A02-1', name: '웹 서버', manufacturer: 'HPE', modelName: 'ProLiant DL360 Gen11', rackStartU: 7, rackEndU: 8 }),
    asset({ id: 122, assetCode: 'STUB-A02-2', name: '캐시 서버', manufacturer: 'Dell', modelName: 'PowerEdge R760', rackStartU: 5, rackEndU: 6 }),
    asset({ id: 123, assetCode: 'STUB-A02-3', name: '아카이브 스토리지', rackStartU: 1, rackEndU: 4 }),
  ],
  // A-03 — 장비 0대(**u맵은 받았고 실제로 비어 있다** — "모름"과 구분돼야 한다)
  13: [],
  // A-04 — **랙 크기 미설정(rackUnits = null)인데 U 배정 자산은 있다.**
  //        U 배치도를 그리면 폴백 42U가 화면으로 샌다 → 그리지 않아야 한다.
  14: [
    asset({ id: 141, assetCode: 'STUB-A04-1', name: '엣지 스위치', category: 'NETWORK', manufacturer: 'Cisco', modelName: 'Catalyst 9200', rackStartU: 4, rackEndU: 5 }),
    asset({ id: 142, assetCode: 'STUB-A04-2', name: '패치 패널', category: 'NETWORK', rackStartU: 1, rackEndU: 3 }),
  ],
  // A-05 — 참인 0 랙에도 장비는 있다
  15: [
    asset({ id: 151, assetCode: 'STUB-A05-1', name: '전원 꺼진 서버', manufacturer: 'Dell', modelName: 'PowerEdge R740', lifecycleStatus: 'REPAIR', rackStartU: 1, rackEndU: 2 }),
  ],
}

/**
 * `EXTRA_RACKS=<n>` — 픽스처 5대 뒤에 합성 랙 n대를 덧붙인다.
 *
 * 랙 수가 많을 때만 드러나는 것(3D 렌더 비용, 폴링 중 카메라 조작, 배치 응답 크기)을
 * 재현하려고 둔다. UAT 실데이터는 랙이 2대뿐이라 이 경로가 안 보인다.
 */
const EXTRA_RACKS = Number(process.env.EXTRA_RACKS ?? 0)
for (let i = 0; i < EXTRA_RACKS; i += 1) {
  const locationId = 200 + i
  racks.push(rack({
    locationId, name: `B-${String(i + 1).padStart(2, '0')}`, code: `B${i + 1}`,
    occupiedUnits: 6, assetCount: 3, temp: 20 + (i % 7), humidity: 40 + (i % 5), powerKw: 1 + (i % 3) / 2,
    collectedAt: '2026-08-21T08:00:00Z', categoryCounts: { SERVER: 3 },
  }))
  uMaps[locationId] = [
    asset({ id: locationId * 10 + 1, assetCode: `STUB-B${i + 1}-1`, name: `합성 서버 ${i + 1}-1`, manufacturer: 'Dell', modelName: 'PowerEdge R760', rackStartU: 5, rackEndU: 6 }),
    asset({ id: locationId * 10 + 2, assetCode: `STUB-B${i + 1}-2`, name: `합성 서버 ${i + 1}-2`, manufacturer: 'HPE', modelName: 'ProLiant DL360', rackStartU: 3, rackEndU: 3 }),
    asset({ id: locationId * 10 + 3, assetCode: `STUB-B${i + 1}-3`, name: `합성 스토리지 ${i + 1}`, rackStartU: 1, rackEndU: 2 }),
  ]
}

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
    // TOKEN_TTL로 액세스 토큰 수명을 줄여 **선제 갱신(①)을 분 단위가 아니라 초 단위로 관측**한다.
    // 기본값은 FMS 실측치(900초)와 같다.
    return json(200, { accessToken: 'stub-access-token', expiresInSeconds: TOKEN_TTL, mustChangePassword: false, user: { username: 'dev', name: '개발자' } })
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
    // categoryCounts는 응답에서 빠질 수 있다. 합이 0이 되는데 그건 "자산 0대"가 아니라 **부재**다 —
    // 장착 수보다 작아지는 순간 표시는 0이 아니라 `—`여야 한다(C6).
    if (SCENARIO === 'category-missing') {
      return json(200, racks.map((r) => (r.name === 'A-02' ? { ...r, categoryCounts: {} } : r)))
    }
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
  // ZONE 일괄 u맵 — 랙 1대당 1요청이던 `/racks/{id}/u-map`을 대체한다(§11-19).
  if (req.url === '/api/zones/101/u-maps') {
    if (SCENARIO === 'umap-fail') return json(500, { code: 'INTERNAL_ERROR', message: '실패' })
    if (SCENARIO === 'umap-hang') return // 응답하지 않는다 — 20초 타임아웃 확인용
    // 랙은 있는데 u맵 항목이 하나도 없는 이상 상태. 화면이 "장비 0대"로 단정하지 않아야 한다(C6).
    if (SCENARIO === 'umap-empty') return json(200, [])
    // 일부 랙만 빠진 응답 — 빠진 랙은 "0대"가 아니라 "반환하지 않음"으로 표시돼야 한다.
    const skip = SCENARIO === 'umap-partial' ? 11 : null
    return json(200, racks
      .filter((r) => r.locationId !== skip)
      .map((r) => ({
        rack: { locationId: r.locationId, name: r.name, code: r.code, rackUnits: r.rackUnits },
        assets: uMaps[r.locationId] ?? [],
      })))
  }
  // 랙 없는 ZONE은 200 [], 없는 ZONE은 404 (실 FMS 실측과 동일)
  if (/^\/api\/zones\/\d+\/u-maps$/.test(req.url ?? '')) {
    return json(404, { code: 'NOT_FOUND', message: '없음' })
  }
  return json(404, { code: 'NOT_FOUND', message: '없음' })
}).listen(PORT, () => console.log(`fms-stub on :${PORT} (SCENARIO=${SCENARIO})`))

process.on('SIGTERM', () => { console.log('\n--- 요청 로그 ---\n' + log.join('\n')); process.exit(0) })

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
import { createHash } from 'node:crypto'
import { readFileSync, existsSync } from 'node:fs'
import { join } from 'node:path'

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
// layout-unset      layout 이 grid:null + objects:[] → "3D 배치가 설정되지 않았습니다" 안내 + 3D 비움
//                   (실측 8 ZONE 중 6개가 이 상태다)
// layout-fail       layout 500 → 씬 안내 + 상단 LIVE·구조 미갱신 확인
// layout-hang       layout 무응답 → 20초 타임아웃 뒤 실패 전환 확인
// layout-partial    A-01·A-03 만 배치 → "랙 3대가 3D 배치에 없습니다" 안내 + 목록·경보엔 남는지 확인
// layout-orphan     랙 목록에 없는 RACK 오브젝트(rack:null 1건 + 미등록 locationId 1건)
//                   → 랙이 아니라 색 박스로 그려지는지 확인 (실측 ZONE 19 재현)
// layout-tile1000   tileMm 1000 · 10x6 그리드 → 상수 하드코딩이 남아 있지 않은지 확인

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
/**
 * 자산 실물 사진(E17). **저장소 밖 디렉터리**에서 읽는다.
 *
 * 사진을 저장소에 두지 않는 이유가 둘이다. ① rack3d 는 사진을 스스로 갖지 않고 netis-fms 에서만
 * 받는다(D1) — 저장소에 두면 그 원칙이 코드가 아니라 말로만 남는다. ② 저장소가 공개라
 * CC BY-SA 이미지를 커밋하면 저작자 표시 의무가 저장소 전체로 번진다.
 *
 * 디렉터리가 없으면 **사진 없는 상태로 정상 동작한다** — 사진은 검증 편의지 스텁의 전제가 아니다.
 * 준비 방법은 그 디렉터리의 README.md 참조.
 */
const PHOTO_DIR = process.env.PHOTO_DIR ?? '/Volumes/ext-ssd/build-artifacts/rack3d/device-photos'

/** 자산 id → 앞/뒤 사진 파일. `null` 은 **그 면이 없는 자산**(요청이 아예 나가면 안 된다). */
const PHOTO_MAP = {
  101: { FRONT: 'hp-proliant-dl385g7_front.jpg', REAR: 'zfs-server_rear.jpg' },
  102: { FRONT: 'hp-proliant-dl380g6_front.jpg', REAR: 'via-nsr7800_rear.jpg' },
  103: { FRONT: 'cisco-nexus-93180yc_front.jpg', REAR: null },
  106: { FRONT: 'cisco-pix515e_front.jpg', REAR: 'cisco-pix515e_rear.jpg' },
  107: { FRONT: 'dell-poweredge-1950_front.jpg', REAR: null },
  108: { FRONT: 'dell-powervault-124t_front.jpg', REAR: null },
}

/** id → { FRONT: {bytes, sha256, ...} | null, REAR: ... }. 없는 면과 못 읽은 파일은 똑같이 null 이다. */
const photos = {}
for (const [id, faces] of Object.entries(PHOTO_MAP)) {
  photos[id] = { FRONT: null, REAR: null }
  for (const view of ['FRONT', 'REAR']) {
    const file = faces[view]
    if (!file) continue
    const path = join(PHOTO_DIR, file)
    if (!existsSync(path)) continue
    const bytes = readFileSync(path)
    photos[id][view] = {
      bytes,
      meta: {
        view,
        contentType: 'image/jpeg',
        byteSize: bytes.length,
        sha256: createHash('sha256').update(bytes).digest('hex'),
        uploadedAt: '2026-08-23T00:00:00Z',
      },
    }
  }
}
const photoCount = Object.values(photos).reduce((n, f) => n + (f.FRONT ? 1 : 0) + (f.REAR ? 1 : 0), 0)
/** 사진이 하나도 없으면 `hasFront`/`hasRear` 를 켜면 안 된다 — 없는 줄 알면서 404를 받아내는 요청이 된다. */
const hasPhoto = (id, view) => Boolean(photos[id]?.[view])

const asset = (o) => ({
  id: 0, assetCode: 'STUB-000', name: '장비', category: 'SERVER', monitoringType: null,
  manufacturer: null, modelName: null, serialNo: null, spec: null, ip: null,
  lifecycleStatus: 'OPERATION', hasFront: false, hasRear: false, ...o,
})

const uMaps = {
  // A-01 — 9대 / 20U. 제조사 3사 + Synology + null 혼재.
  11: [
    asset({ id: 101, assetCode: 'STUB-A01-1', name: 'DB 서버 #1', manufacturer: 'HP', modelName: 'ProLiant DL385 G7', serialNo: 'SN-H-1', ip: '10.0.0.11', rackStartU: 19, rackEndU: 20, hasFront: hasPhoto(101, 'FRONT'), hasRear: hasPhoto(101, 'REAR') }),
    asset({ id: 102, assetCode: 'STUB-A01-2', name: 'DB 서버 #2', manufacturer: 'HP', modelName: 'ProLiant DL380 G6', serialNo: 'SN-H-2', ip: '10.0.0.12', rackStartU: 17, rackEndU: 18, hasFront: hasPhoto(102, 'FRONT'), hasRear: hasPhoto(102, 'REAR') }),
    asset({ id: 103, assetCode: 'STUB-A01-3', name: '코어 스위치', category: 'NETWORK', manufacturer: 'Cisco', modelName: 'Nexus 93180YC-EX', ip: '10.0.0.13', rackStartU: 16, rackEndU: 16, hasFront: hasPhoto(103, 'FRONT'), hasRear: hasPhoto(103, 'REAR') }),
    asset({ id: 104, assetCode: 'STUB-A01-4', name: '스토리지 어레이', manufacturer: 'Synology', modelName: 'RS4021xs+', rackStartU: 12, rackEndU: 15 }),
    asset({ id: 105, assetCode: 'STUB-A01-5', name: '제조사 미등록 서버', rackStartU: 10, rackEndU: 11 }),
    asset({ id: 106, assetCode: 'STUB-A01-6', name: '워커 #1', manufacturer: 'Cisco', modelName: 'PIX 515E', rackStartU: 9, rackEndU: 9, hasFront: hasPhoto(106, 'FRONT'), hasRear: hasPhoto(106, 'REAR') }),
    asset({ id: 107, assetCode: 'STUB-A01-7', name: '워커 #2', manufacturer: 'Dell', modelName: 'PowerEdge 1950', rackStartU: 8, rackEndU: 8, hasFront: hasPhoto(107, 'FRONT'), hasRear: hasPhoto(107, 'REAR') }),
    asset({ id: 108, assetCode: 'STUB-A01-8', name: '백업 노드', manufacturer: 'Dell', modelName: 'PowerVault 124T', rackStartU: 5, rackEndU: 6, hasFront: hasPhoto(108, 'FRONT'), hasRear: hasPhoto(108, 'REAR') }),
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

/**
 * ZONE 3D 배치 픽스처 — `GET /api/layouts/zones/{zoneId}/layout` (E18).
 *
 * **좌표계**: 원점 (0,0) = 좌상단, x = 열(오른쪽 = EAST), z = 행(아래 = SOUTH) → NORTH = z 감소.
 * `dir` 은 오브젝트 **정면(FRONT)** 이 향하는 방위다(§11-30). 랙 4대에 4방위를 한 번씩 넣어
 * 회전 매핑이 뒤집혔는지 눈으로 바로 갈리게 했다 — dir=NORTH 랙은 정면이 그리드 위쪽을 봐야 한다.
 *
 * 비-RACK 은 팔레트 12종 중 6종을 깔아 색·레이블·높이가 종류별로 갈리는지 본다.
 * `UNKNOWN_KIND` 는 **FMS 가 나중에 type 을 늘린 상황**의 재현이다 — 회색 박스 + type 레이블로
 * 안전하게 넘어가야 하고, 절대 씬이 깨지면 안 된다.
 * `label: ''` 인 건은 표시명이 `type` 으로 대체되는지 본다.
 */
const layoutObject = (o) => ({ dir: 'NORTH', label: '', rack: null, asset: null, ...o })

const layoutObjects = [
  layoutObject({ id: 1, type: 'RACK', x: 2, z: 2, dir: 'NORTH', label: 'A-01', rack: { locationId: 11, name: 'A-01', code: 'A01', rackUnits: 42 } }),
  layoutObject({ id: 2, type: 'RACK', x: 4, z: 2, dir: 'EAST', label: 'A-02', rack: { locationId: 12, name: 'A-02', code: null, rackUnits: 42 } }),
  layoutObject({ id: 3, type: 'RACK', x: 6, z: 2, dir: 'SOUTH', label: 'A-03', rack: { locationId: 13, name: 'A-03', code: null, rackUnits: 20 } }),
  // 랙 크기 미설정(rackUnits: null) — 박스/프레임 높이를 지어내되 **화면 수치로는 새지 않아야** 한다.
  layoutObject({ id: 4, type: 'RACK', x: 8, z: 2, dir: 'WEST', label: 'A-04', rack: { locationId: 14, name: 'A-04', code: null, rackUnits: null } }),
  layoutObject({ id: 5, type: 'RACK', x: 2, z: 5, dir: 'SOUTH', label: 'A-05', rack: { locationId: 15, name: 'A-05', code: null, rackUnits: 42 } }),
  layoutObject({ id: 6, type: 'CRAC', x: 10, z: 1, dir: 'WEST', label: '항온항습기 #1' }),
  layoutObject({ id: 7, type: 'UPS', x: 10, z: 3, dir: 'WEST', label: 'UPS' }),
  layoutObject({ id: 8, type: 'POWER', x: 10, z: 5, dir: 'WEST', label: '' }),           // label 빈 문자열 → 'POWER'
  layoutObject({ id: 9, type: 'SENSOR', x: 5, z: 6, dir: 'NORTH', label: '온습도 센서' }),
  layoutObject({ id: 10, type: 'DOOR', x: 0, z: 7, dir: 'EAST', label: '방화문' }),
  layoutObject({ id: 11, type: 'UNKNOWN_KIND', x: 7, z: 6, dir: 'NORTH', label: '' }),   // 미지원 type → 회색 박스 + 'UNKNOWN_KIND'
  layoutObject({ id: 12, type: 'GAS', x: 9, z: 6, dir: 'NORTH', label: '가스 소화 설비' }),
  // ⚠️ `BATTERY` 는 **아직 FMS 팔레트에 없다**(신설 요청 중). 여기 넣어 두는 것은
  // "FMS 가 내보내기 시작하면 rack3d 를 안 고쳐도 모델이 붙는다"를 실제로 확인하기 위해서다.
  // FMS 가 이 type 을 서빙하기 전까지 실환경에서는 나오지 않는다.
  layoutObject({ id: 13, type: 'BATTERY', x: 11, z: 6, dir: 'NORTH', label: '배터리 랙' }),
]

/**
 * `EXTRA_RACKS` 합성 랙도 배치에 올린다 — 안 올리면 전부 "미배치"가 되어
 * 3D 렌더 비용·폴링 중 카메라 조작 재현이 안 된다. 기본 8행 아래에 12칸씩 새 행으로 깐다.
 */
const EXTRA_ROWS = Math.ceil(EXTRA_RACKS / 12)
racks.filter((r) => r.locationId >= 200).forEach((r, i) => {
  layoutObjects.push(layoutObject({
    id: 500 + i,
    type: 'RACK',
    x: i % 12,
    z: 8 + Math.floor(i / 12),
    dir: ['NORTH', 'EAST', 'SOUTH', 'WEST'][i % 4],
    label: r.name,
    rack: { locationId: r.locationId, name: r.name, code: r.code, rackUnits: r.rackUnits },
  }))
})

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
  // ZONE 3D 배치(E18). 미설정 ZONE 은 200 { grid: null, objects: [] }, 없는 id 는 404 — 실측과 동일.
  if (req.url === '/api/layouts/zones/101/layout') {
    if (SCENARIO === 'layout-fail') return json(500, { code: 'INTERNAL_ERROR', message: '실패' })
    if (SCENARIO === 'layout-hang') return // 응답하지 않는다 — 20초 타임아웃 확인용
    const head = { zone: { id: 101, name: zone.name, code: zone.code } }
    if (SCENARIO === 'layout-unset') return json(200, { ...head, grid: null, objects: [] })
    if (SCENARIO === 'layout-tile1000') {
      return json(200, {
        ...head,
        grid: { cols: 10, rows: 6, tileMm: 1000, ceilingMm: 4200 },
        objects: layoutObjects.filter((o) => o.x < 10 && o.z < 6),
      })
    }
    const grid = { cols: 12, rows: 8 + EXTRA_ROWS, tileMm: 600, ceilingMm: 2800 }
    if (SCENARIO === 'layout-partial') {
      // A-02·A-04·A-05 는 배치 없음 → 3D 에 안 그려지되 목록·검색·경보에는 남아야 한다.
      const keep = new Set([11, 13])
      return json(200, { ...head, grid, objects: layoutObjects.filter((o) => o.type !== 'RACK' || keep.has(o.rack?.locationId)) })
    }
    if (SCENARIO === 'layout-orphan') {
      return json(200, {
        ...head,
        grid,
        objects: [
          ...layoutObjects,
          // 실측 ZONE 19 재현 — type RACK 인데 rack 참조가 없다.
          layoutObject({ id: 90, type: 'RACK', x: 1, z: 0, dir: 'SOUTH', label: '랙-01' }),
          // 랙 목록에 없는 locationId — 랙이 아니라 박스로 그려져야 한다.
          layoutObject({ id: 91, type: 'RACK', x: 3, z: 0, dir: 'NORTH', label: '유령 랙', rack: { locationId: 9999, name: '유령 랙', code: null, rackUnits: 42 } }),
        ],
      })
    }
    return json(200, { ...head, grid, objects: layoutObjects })
  }
  if (/^\/api\/layouts\/zones\/\d+\/layout$/.test(req.url ?? '')) {
    return json(404, { code: 'NOT_FOUND', message: '없음' })
  }

  // ── 자산 실물 사진(E17) ────────────────────────────────────────────────────
  const [imgPath, imgQuery = ''] = (req.url ?? '').split('?')

  const metaMatch = /^\/api\/assets\/(\d+)\/images$/.exec(imgPath)
  if (metaMatch) {
    if (SCENARIO === 'photo-meta-fail') return json(500, { code: 'INTERNAL', message: '실패' })
    const faces = photos[metaMatch[1]] ?? { FRONT: null, REAR: null }
    // 없는 면은 **null 이다.** 다른 면으로 대신 채우면 앞면 사진이 뒷면에 붙는다(C6).
    return json(200, { front: faces.FRONT?.meta ?? null, rear: faces.REAR?.meta ?? null })
  }

  const fileMatch = /^\/api\/assets\/(\d+)\/images\/(FRONT|REAR)$/.exec(imgPath)
  if (fileMatch) {
    if (SCENARIO === 'photo-fail') return json(500, { code: 'INTERNAL', message: '실패' })
    if (SCENARIO === 'photo-hang') return // 응답하지 않는다 — 사진 요청 타임아웃 확인용
    const face = photos[fileMatch[1]]?.[fileMatch[2]]
    if (!face) return json(404, { code: 'NOT_FOUND', message: '없음' })

    // FMS main-b8bc839 의 캐시 정책(§11-15)을 그대로 흉내 낸다.
    // `v` 가 있으면 URL 자체가 내용에 묶이므로 1년 immutable, 없으면 3600초 + ETag 재검증.
    // **고정 URL 에 immutable 을 걸면 안 된다** — 사진을 갈아끼워도 옛 바이트가 계속 나온다.
    const versioned = new URLSearchParams(imgQuery).has('v')
    const etag = `"${face.meta.sha256}"`
    if (!versioned && req.headers['if-none-match'] === etag) {
      res.writeHead(304, { ETag: etag, 'Cache-Control': 'private, max-age=3600' })
      return res.end()
    }
    res.writeHead(200, {
      'Content-Type': face.meta.contentType,
      'Content-Length': face.meta.byteSize,
      ETag: etag,
      'Cache-Control': versioned
        ? 'private, max-age=31536000, immutable'
        : 'private, max-age=3600',
    })
    return res.end(face.bytes)
  }

  return json(404, { code: 'NOT_FOUND', message: '없음' })
}).listen(PORT, () => {
  console.log(`fms-stub on :${PORT} (SCENARIO=${SCENARIO})`)
  console.log(photoCount > 0
    ? `  장비 사진 ${photoCount}장 — ${PHOTO_DIR}`
    : `  장비 사진 없음 (${PHOTO_DIR} 없음) — hasFront/hasRear 는 전부 false 로 나간다`)
})

process.on('SIGTERM', () => { console.log('\n--- 요청 로그 ---\n' + log.join('\n')); process.exit(0) })

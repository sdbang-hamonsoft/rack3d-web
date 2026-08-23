# 개발용 도구 (배포에 포함되지 않음)

`.dockerignore`가 `scripts`를 제외하므로 운영 이미지에 들어가지 않는다.

## `fms-stub.mjs` — netis-fms 스텁 서버

netis-fms 개발 계정 없이 **로그인 이후 화면 전체**를 실제로 렌더해 검증하기 위한 모형 서버다.
의존성 0(`node:http`만 사용).

```bash
node scripts/dev/fms-stub.mjs                                  # 기본 포트 8777
VITE_FMS_ORIGIN=http://localhost:8777 npm run dev              # rack3d를 스텁에 물린다
```

`SCENARIO` 환경변수로 실패 경로를 재현한다.

| 값 | 재현 대상 |
|---|---|
| `ok`(기본) | 정상 응답 |
| `429` | 레이트리밋 + `Retry-After` — 폴링 백오프 확인 |
| `429-once` | 첫 요청만 `Retry-After: 86400` — 백오프 상한(300초) 클램프와 "지금 새로고침" 복구 확인 |
| `hang` | sidebar 무응답 — 로비 로딩 타임아웃(20초) 확인 |
| `racks-hang` | racks 무응답 — 씬 상태·`LIVE` 뱃지가 `갱신 실패`로 바뀌는지 확인 |
| `scope-denied` | 위치 스코프 밖 404 — "권한 없음" 수렴 확인 |
| `umap-fail` | ZONE u맵 500 — "불러오지 못했습니다" + 상단 `LIVE · 구조 미갱신` 확인 |
| `umap-hang` | ZONE u맵 무응답 — 20초 타임아웃 뒤 실패 전환 확인 |
| `umap-empty` | ZONE u맵 `200 []` — 랙은 있는데 항목이 없다. "장비 0대"로 단정하지 않는지 확인 |
| `umap-partial` | A-01만 응답에서 누락 — "netis-fms가 이 랙의 U 배치를 반환하지 않았습니다" 확인 |
| `category-missing` | A-02 `categoryCounts` 필드 부재(`assetCount` 3) — "랙 내 자산"이 `0`이 아니라 `—`, "U 미배정 −3대" 같은 음수가 안 나오는지 확인 |
| `layout-unset` | 배치 `grid: null` + `objects: []` — **"3D 배치가 설정되지 않았습니다" 안내 + 3D 비움**. 실측 8 ZONE 중 6개가 이 상태라 가장 자주 뜨는 화면이다 |
| `layout-fail` | 배치 500 — 씬 안내 + 상단 `LIVE · 구조 미갱신` 확인 |
| `layout-hang` | 배치 무응답 — 20초 타임아웃 뒤 실패 전환 확인 |
| `layout-partial` | A-01·A-03 만 배치 — "랙 3대가 3D 배치에 없습니다" 안내. **목록·검색·경보에는 남아야 한다**(경보 랙이 조용히 사라지면 안 된다) |
| `layout-orphan` | 랙 목록에 없는 RACK 오브젝트(`rack: null` 1건 + 미등록 `locationId` 1건) — 랙이 아니라 색 박스로 그려지는지 확인(실측 ZONE 19 재현) |
| `layout-tile1000` | `tileMm 1000` · 10×6 그리드 — 그리드 상수 하드코딩이 남아 있지 않은지 확인 |

| `photo-meta-fail` | `GET /assets/{id}/images` 500 — 메타 실패가 사진 없는 상태로 수렴하는지(씬은 살아 있어야 한다) |
| `photo-fail` | 사진 바이트 500 — 실패 쿨다운이 걸리는지, 같은 면을 무한 재요청하지 않는지 |
| `photo-hang` | 사진 무응답 — 동시 4건 슬롯이 막힌 채 남지 않는지 |

`EXTRA_RACKS=<n>`으로 합성 랙을 덧붙인다(예: `EXTRA_RACKS=31` → 총 36대).
**랙 수가 많을 때만 드러나는 것**(3D 렌더 비용, 폴링 중 카메라 조작, 배치 응답 크기)을
재현하는 용도다 — UAT 실데이터는 랙이 2대뿐이라 이 경로가 안 보인다.

`TOKEN_TTL`(초, 기본 900)로 액세스 토큰 수명을 줄이면 **선제 갱신(①)을 초 단위로 관측**할 수 있다.
`TOKEN_TTL=90` 이면 만료 60초 전 + 바닥값 30초 규칙에 따라 **탭이 보이는 동안 30초마다** refresh가 나가고,
탭을 숨기면 멈춰야 한다(C11).

### 픽스처가 가르는 네 경우 (C6 — 가짜 0 금지)

관제 화면에서 **"측정값이 없음"과 "측정값이 0"은 반드시 다르게 보여야 한다.**
이 구분이 무너지면 실제로 뜨거운 랙이 0℃로 보이는 사고가 난다.

| 랙 | 상태 | 기대 표시 |
|---|---|---|
| A-01 | 센서 있음(높은 값·CRITICAL) | 실측값 |
| A-02 | 센서 있음(낮은 값) | 실측값 |
| A-03 | **센서 없음** (`temp`/`humidity`/`powerKw` = `null`) | **`—`** + 히트맵 중립 회색 |
| A-04 | **랙 크기 미설정** (`rackUnits` = `null`) + 통신두절(`stale`) | 점유율 `—`, 42U를 지어내지 않는다 |
| A-05 | **참인 0** (`temp`/`humidity`/`powerKw` = `0`) | **`0`** — `—`가 아니다 |

### 랙 u맵 픽스처 (`GET /api/zones/{zoneId}/u-maps` — ZONE 일괄)

| 랙 | u맵 | 기대 표시 |
|---|---|---|
| A-01 | 9대 / 20U, 제조사 Dell·HPE·Cisco·Synology·null 혼재 | 제조사·모델은 **FMS 원값**, 미등록은 `—`. 3D 형상은 근사 |
| A-02 | 3대 / 8U | 4U 자산이 2U GLB를 늘려 실제 높이로 |
| A-03 | **0대(수신 완료)** | "U가 배정된 장비가 없습니다" — "불러오는 중"이 아니다 |
| A-04 | 2대 / 5U인데 **랙 크기 미설정** | **U 배치도를 그리지 않는다**(폴백 42U 누출 금지). MAX BLOCK `—` |
| A-05 | 1대, `lifecycleStatus: REPAIR` | 생애주기는 중립 배지로 원값 표기(건강 상태 아님) |

### ZONE 3D 배치 픽스처 (`GET /api/layouts/zones/{zoneId}/layout` — E18)

좌표계는 **원점 (0,0) = 좌상단, x = 열(오른쪽 = EAST), z = 행(아래 = SOUTH) → NORTH = z 감소**다.
`dir` 은 오브젝트 **정면(FRONT)** 이 향하는 방위(§11-30).

| 오브젝트 | 확인 대상 |
|---|---|
| RACK A-01~A-04 에 `dir` 4방위를 한 번씩 | **회전 매핑이 뒤집혔는지 눈으로 갈린다** — `dir: NORTH` 랙은 정면이 그리드 **위쪽**을 봐야 한다 |
| A-03 `rackUnits 20` / A-04 `rackUnits null` | 랙 크기가 화면 수치로 샐 때 드러난다(U 배치도·RACK SIZE 는 FMS 원값, 미설정은 `—`) |
| CRAC·UPS·POWER·SENSOR·DOOR | 종류별 색(FMS 2D 에디터 팔레트)·높이·레이블이 갈리는지 |
| `POWER`·`UNKNOWN_KIND` 는 `label: ''` | 표시명이 **`type` 으로 대체**되는지(지어내지 않는다) |
| `UNKNOWN_KIND` | **FMS 가 나중에 type 을 늘린 상황** — 회색 박스 + type 레이블로 넘어가야 하고 씬이 깨지면 안 된다 |

### 장비 실물 사진 (E17)

`PHOTO_DIR`(기본 `/Volumes/ext-ssd/build-artifacts/rack3d/device-photos`)에서 읽어
`GET /api/assets/{id}/images`(메타)와 `.../images/{FRONT|REAR}`(바이트)를 FMS 계약대로 서빙한다.
**디렉터리가 없으면 사진 없는 상태로 정상 동작한다** — `hasFront`/`hasRear` 가 전부 `false` 로 나가고,
그러면 rack3d 는 이미지 엔드포인트를 **한 번도 부르지 않는다**(그게 맞는 동작이다).

사진을 저장소에 두지 않는 이유가 둘이다. ① rack3d 는 사진을 스스로 갖지 않고 netis-fms 에서만
받는다(D1). ② 저장소가 공개라 CC BY-SA 이미지를 커밋하면 저작자 표시 의무가 저장소로 번진다.
사진 준비 방법과 출처·라이선스는 그 디렉터리의 `README.md` 에 있다.

캐시 헤더도 FMS `main-b8bc839` 와 같게 흉내 낸다 — `?v=` 있으면 `max-age=31536000, immutable`,
없으면 `max-age=3600` + ETag(`If-None-Match` 에 304). 고정 URL 에 immutable 을 걸면 사진을
갈아끼워도 옛 바이트가 계속 나온다는 것이 이 설계의 요지다(§11-15).

| 자산 | 사진 | 확인 대상 |
|---|---|---|
| 101 (2U) | 앞 HP DL385 G7 · 뒤 2U 후면 | 앞뒤가 뒤바뀌지 않는지, 뒷면 UV 반전이 맞는지 |
| 103 (1U) | **앞면만** | 뒷면 요청이 **0건**인지(`hasRear:false` 를 믿는가) |
| 106 (1U) | 앞·뒤 **같은 장비**(Cisco PIX 515E) | 유일한 진짜 앞뒤 쌍 — 앞뒤 대조는 여기서 한다 |
| 104·105·109 | 없음 | 메타 요청조차 나가지 않는지 |

### ⚠️ 한계

이것은 **문서(`E19-rack3d-dashboard-api-request.md` §I, FMS DTO)대로 만든 모형**이지 실제 FMS가 아니다.
여기서 통과한다고 계약이 실제와 맞는다는 뜻이 아니다 — **개발 계정이 나오면 실응답과 대조해야 한다.**

## `cdp.mjs` — 헤드리스 Chrome 드라이버

Chrome DevTools Protocol을 직접 쓰는 최소 클라이언트(의존성 0).
스텁과 함께 써서 로그인 이후 화면을 실제로 렌더하고 DOM·콘솔·네트워크를 확인한다.

> **훅과 렌더 동작은 순수 함수 테스트로 잡히지 않는다.**
> 실제로 `tsc`·`eslint`·단위 테스트를 전부 통과한 상태에서 무한 렌더가 나간 적이 있고,
> 화면을 띄워보고서야 발견했다. 렌더 경로를 바꿨으면 반드시 띄워서 확인할 것.

스텝은 `{eval}`(JS 실행) · `{wait}`(밀리초) · `{shot: '/절대경로.png'}`(화면 캡처) 셋이다.
**3D 는 DOM 으로 확인되지 않는다** — 사진이 실제로 붙었는지, 무엇이 가렸는지는 떠 봐야 안다.

헤드리스에서 WebGL 을 쓰려면 SwiftShader 를 켜야 한다. `--disable-gpu` 만 주면 캔버스가
새까맣게 나오고 "안 붙었다"로 오독하기 쉽다.

```bash
"/Applications/Google Chrome.app/Contents/MacOS/Google Chrome" \
  --headless=new --remote-debugging-port=9222 --window-size=1600,900 \
  --use-gl=angle --use-angle=swiftshader --enable-unsafe-swiftshader \
  --user-data-dir=<임시 프로필> http://localhost:5173/rack3d/
```

**임시 프로필은 쓰고 나면 지운다.** 실 FMS 로 로그인해 확인한 경우 그 디렉터리에 운영 세션
쿠키(`NETIS_RT`)가 남는다.

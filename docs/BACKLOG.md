# Backlog

이 파일은 프로젝트 작업의 단일 기준(SSOT)이다.

## 할 일

- [ ] 🛠 확정 대시보드 UI 재구현 — FMS 가능 데이터 기준(D2)
  - `series/zone`(E19 B4) 연동으로 온습도 트렌드 카드 채우기 → 이때 echarts 복원(Q3)
  - 시설 6종·KPI 5카드를 §4 매트릭스의 ✅ 항목으로 재구성
- [ ] 3D 랙 형상이 항상 42U GLB다 — `rackUnits` 가 20U·48U 인 랙도 42U 프레임으로 그려지고 `rackEndU > 42` 자산은 프레임을 뚫는다(`rackLayouts.ts` `toServerData` 가 상한 미검사). 실고객 데이터에 42U 아닌 랙이 오면 드러난다
- [ ] `LIVE` 뱃지가 "응답은 오는데 값이 낡은 경우"를 못 잡는다
  - 현재 판정은 `failure`/`lastUpdatedAt`(rack3d가 응답 받은 시각)만 본다. FMS가 stale 데이터를 200으로 주면 여전히 `LIVE`
  - FMS 랙 목록 DTO에 `stale`(통신두절 센서 존재)·`collectedAt`(측정 수신 시각)이 있다. 이 둘로 판정하면 렌더 중 시계를 읽지 않고(purity 유지) 해결된다. 랙 상세는 이미 표시 중이라 집계만 올리면 됨
- [x] ~~백오프 상한 300초가 FMS 레이트리밋 창과 맞는지 확인~~ → **해소(2026-08-22).** FMS 회신 §11-16: rack3d 가 쓰는 조회 계열·`/api/auth/refresh` 에 레이트리밋이 **전혀 없다**(`RateLimiterService` 는 전역 필터가 아니라 명시 호출 구조이고 조회 서비스는 호출 0, nginx 계층도 없음). 문서의 30회/분은 로그인 전용이었다
  - 코드 주석 5곳의 근거를 정정했다. **결론(재시도 1회 상한·single-flight·수동 재시도 쿨다운)은 유지** — 무한 재시도는 레이트리밋과 무관하게 잘못된 동작이다
  - ⚠️ `fms-integration-security.md` §13 의 리스크 **R6 서술은 근거가 뒤집혔다**. 문서 정리 시 반영할 것
- [ ] accessToken 선제 갱신 — `TokenResponse.expiresInSeconds`(현재 타입에만 있고 미사용, `src/api/client.ts:25`)로 만료 60초 전 자동 refresh 예약
  - 401 반응 재시도(②)는 이미 있으므로 **정합성 장치가 아니라 401 왕복을 줄이는 최적화**다
  - ⚠️ C11(탭 비활성 시 폴링 중단)과 충돌한다 — 타이머를 그냥 걸면 숨긴 탭에서도 14분마다 refresh 가 나간다. 탭이 보이는 동안만 예약하고, 복귀 시 남은 수명이 임계 이하면 즉시 갱신하는 방식으로 (§11-8)
  - **실응답 대조 라운드와 함께 처리** — 계약 불일치 수정과 묶어야 리뷰·QA 사이클이 한 번으로 끝난다
- [ ] 빌드 환경 — 기본 PATH의 node가 x64라 `npm run build` 실패(rolldown 네이티브 바인딩 arm64만 설치됨). 맥미니 원격 빌드 시 `node -p process.arch` 확인 필요. 근본 해결은 아키텍처 일치 상태에서 `npm ci` 재실행
- [ ] SSE 기반 실시간 갱신 검토 — **보류.** netis-fms `RealtimeHub`가 push하는 것은 `rawEvent`/`ticket`/`accessTag` 3종뿐이고 온도·전력 push 계획이 없음(회신 I-5). 장애 테이블에만 2단계로 붙일 값어치가 있는지 재검토
- [ ] 🛠 3D 배치 좌표를 FMS로 이관 (E18) — **우선순위 상향.** 제품 오너가 FMS 레이아웃 설정에서 랙 위치를 바꿔도 rack3d 에 반영되지 않는다고 보고(2026-08-22)
  - **버그가 아니라 미구현이다.** `src/api/` 에 layouts 참조 0건, 좌표는 전부 `localStorage`(`rack3d-layout:<dataCenterId>`)에서 읽고 없으면 `autoArrangeRacks` 로 채운다
  - API 는 정상 동작 확인: `grid{cols:12,rows:8,tileMm:600,ceilingMm:2800}` + `objects[{id,type,x,z,dir,label,rack,asset}]`
  - ✅**확정 (2026-08-22, 사용자): 편집은 FMS 에서만. rack3d 는 읽기 전용.**
    - LayoutEditor 의 좌표 편집·저장을 제거하고 보기 전용으로 바꾼다. `PUT` 을 쓰지 않으므로 SETTINGS WRITE 권한 분기도 불필요해진다
    - 근거: 편집 지점이 두 곳이면 어느 쪽이 정답인지 흐려진다. 랙 추가·삭제를 이미 FMS SSOT 로 뺀 것(Q-8)과 일관된다
  - netis-fms 협의 중(4건): 그리드 규격 수용 범위(`tileMm` 600 외 값·`ceilingMm` 반영) / `dir` 열거값 ↔ 도 매핑 기준 / CRAC·UPS 등 비-랙 오브젝트 렌더 여부(형상 없음 — 1차 제외 제안) / 기존 localStorage 처리와 layout 미설정 ZONE 표시
- [ ] 🔵 netis-fms 장비 실물 이미지(FRONT/REAR)를 3D 랙 장비 앞뒤면 텍스처로 실시간 표시
  - 2026-08-21 PM 검토 완료: **재모델링 불필요**. 현재 GLB가 이미 `섀시 + 앞면 사진 평면 + 뒷면 사진 평면` 구조라(`*_PhotoFront`/`*_PhotoRear` 머티리얼) 런타임 텍스처 교체로 구현 가능. 진입점 `src/App.tsx:500 cloneModel()`
  - 부수효과: GLB 없는 장비(스위치/스토리지/PDU)도 "U높이 + 앞뒤 사진"으로 표현 가능 → 장비 확장이 모델링을 유발하지 않음
  - **선행 조건(netis-fms E17 계약)**: 요구사항 문서를 netis-fms에 전달함 → `netis-fms/docs/EPIC-E17-rack3d-texture-consumption.md`
    - ~~R1 텍스처용 축소본 엔드포인트~~ → **해결됨(2026-08-22).** `?variant=texture` 가 JPEG 로 내려오는 것을 실측 확인(원본 PNG 613B → texture JPEG 4167B, ETag 에 `-t` 접미사)
    - ~~R2 헤더 없이 접근 가능한 인증~~ / ~~R3 CORS 허용~~ → **D4(같은 오리진 `/rack3d/` 배포)로 불필요해짐.** 이미지는 fetch→blob으로 처리
    - R4 이미지 sha·updatedAt 노출 / R5 정면 크롭 가이드
  - **선행 조건 전부 해소.** R2·R3 는 D4(같은 오리진)로 불필요, R1 은 구현 완료. 착수 가능
  - ⚠️ **착수 시 netis-fms 와 동시 작업이 필요하다** — 이미지 캐시를 `?v=<sha256>` 방식으로 붙인다(§11-15 설계, FMS 합의됨)
    - rack3d: `/api/assets/{id}/images` 메타의 `sha256` 을 이미지·텍스처 요청에 `?v=<sha>` 로 부착
    - netis-fms: `v` 파라미터가 있으면 `Cache-Control: private, max-age=31536000, immutable` 로 응답 + `v` 없는 기존 계약은 기본 60s → 3600s 상향
    - **안정 URL 에 그냥 `immutable` 을 걸면 안 된다** — 프레시니스 동안 재검증 자체가 막혀 사진 교체 후에도 옛 바이트가 나간다. 콘텐츠 주소화 URL 에서만 옳다(FMS 가 지적해 준 함정)
    - 착수 순서가 정해지면 **먼저 netis-fms 에 알려 파이프라인을 함께 태울 것**
  - ⚠️ 종횡비: FMS 이미지는 1U 기준 11.0(19인치 = 마운팅 이어 포함 전폭), rack3d 사진 평면은 10.01(섀시 본체 폭 445mm). **평면을 다시 굽지 않고 텍스처 적용 시 이미지 실비율로 평면 스케일을 보정**하기로 했다(§11-14)
  - ⚠️ 테스트 이미지는 160×320(세로가 긴 비율)이라 랙 규격(1U≈10:1)과 어긋난다. 실 장비 정면 크롭이 들어와야 제대로 보인다(R5)

## 완료

- [x] 2026-08-22 netis-fms 실연동 3단계 — ZONE 배치 u맵 전환 + 폴링 정책 분리
  - `GET /api/zones/{zoneId}/u-maps` (FMS `main-0e29da7`) 로 전환. **랙 36대 기준 요청 36건 → 1건**
  - `src/hooks/useRackUMaps.ts` **파일 삭제** — 커서·요청 간격·스윕 주기·재시도 스윕·지수 백오프·중복 가드·`pruneCollection`·정렬 키·`failedRackIds` 전부 소멸(부분 실패 개념 자체가 없어짐). **남은 u맵 코드 9줄**
  - 페어링은 **`locationId` 값 매칭**. FMS 가 순서 일치를 계약으로 보장했지만 두 엔드포인트 간 순서 결합에 기대지 않는다 — 유령 랙·인덱스 어긋남이 구조적으로 불가능해진다
  - **폴링 정책 분리**(사용자 지시): 텔레메트리 30초 유지 / **구조는 ZONE 진입 시 1회**, 자동 재수집 없음. 값 비교 감지도 넣지 않았다 — "fms 에서 바꿨으면 다시 실행하면 된다"
    - 짝으로 **상단바 "지금 새로고침" 상시 노출**(랙 목록 + u맵 동반 갱신, 5초 쿨다운). 전에는 실패 화면에만 있어 정상 상태에서 구조를 갱신할 수단이 없었다
    - "1회"는 **성공적으로** 1회다 — 진입 직후 일시적 단절 하나로 씬이 영구히 빈 채 남지 않도록 실패 시에만 재시도하고 성공하면 닫는다(`usePolledResource` `repeat:false` → `settled`)
  - u맵 상태 4단 분기: 로딩 / 못 받고 실패 / **응답에 이 랙 없음** / 받았고 갱신만 실패(옛 목록 유지 + `⚠ 갱신 실패` 배너 + 상단바 `구조 미갱신`)
    - "응답에 이 랙 없음" 문구를 **원인 단정에서 사실 서술로** 고쳤다. `repeat:false` 도입으로 "FMS 가 안 줬다"는 전제가 깨졌다 — 진입 후 새로 등록된 랙이면 우리가 다시 안 물어본 것이다. 관제 화면이 남의 시스템 이상을 단정하면 운영자가 엉뚱한 곳을 뒤진다
  - QA 가 관찰한 "스코프 밖 ZONE 에 404 대신 200 []" 은 **FMS 확인 결과 정상 동작**이었다(§11-21). id 1·2·3 이 BUILDING 이고 rack3d-dev 스코프 안이라 "스코프 안 비-ZONE → 직속 RACK 0 → 200 []" 이 맞다. 진짜 스코프 밖 ZONE→404 는 FMS 통합테스트로 증명돼 있다. **문서·UI 모두 변경 불요**
  - 리뷰 2라운드·QA 1라운드 전부 통과. QA 는 **실 FMS 에 붙여** 검증(u맵 1건/145초, racks 30.1초, 재진입만 자동 갱신, 탭 토글 0건, 새로고침 12연타에도 각 1건)


- [x] 2026-08-22 netis-fms 실연동 2단계 — 랙 내부 장비(u맵) + 토큰 선제 갱신
  - `GET /api/racks/{id}/u-map` 연동 → 랙 안에 자산이 실제 U 위치로 렌더된다. `rackStartU`~`rackEndU`, 3D 형상은 GLB 3종 근사 + **Y축을 `units / 모델고유U` 배로 스케일**해 U 점유는 실데이터와 정확히 일치(4U 자산 실측 확인)
  - **`ServerStatus`(healthy/warning/critical/offline) 타입째 삭제** — FMS 에 IT 장비 텔레메트리가 없어 그 색은 시드로 지어낸 값이었다. `lifecycleStatus` 는 중립 배지 원값만(C6). 랙 단위 경보는 FMS `severity` 실값이라 유지
  - **`assetCount`(U 배정) vs `categoryCounts`(랙 내 전체) 라벨 분리** — 3계층 어휘 통일: 로비 `ZONE ASSETS` ⊇ 상단바 `IN RACKS` ⊇ `MOUNTED`. FMS 가 §11-11 로 정의를 확정해 준 건이고, 랙 17(`assetCount 4` vs 합 5)로 실데이터 검증
  - **가짜 온도 시계열 제거**(D3·Q5-b) — 카드는 자리만 남기고 `—` + `미연동 · E19 B4` + 출처 표기. 부수 효과로 echarts 참조가 0 이 되어 **번들 JS 1,823 → 1,306 kB(−28%, gzip −32%)**
  - **echarts 의존성 제거** — 설치 용량 −61.6MB(echarts 57.5 + zrender 4.1), lock 243 → 239. 대시보드 재구현 시 복원(`npm i echarts`, Q3 결정 유지). *번들 감소는 코드 제거의 몫이고 패키지 제거의 몫은 설치 용량·공급망 표면이다 — 별개다*
  - `SidebarNode.code` optional 정정(실응답 대조 §11-10), accessToken 선제 갱신(탭 가시성 연동 — FMS 프론트의 평이한 setTimeout 방식은 C11 과 충돌해 채택하지 않음)
  - 리뷰 지적 🔴 2 + 🟡 7 처리: **스윕 중 3D 조작 불능**(랙 배열 신원 churn → 카메라 전이 무한 리셋, 랙 36대면 18초 · 300초마다 반복)을 `CameraController` 의존성을 스칼라로 바꿔 해소. 랙 캐시를 끈 격리 검증으로 확인
  - 실 FMS(`rack3d-dev` 계정)로 검증. 이전 단계까지는 전부 문서 기반 스텁이었다


- [x] 2026-08-22 커밋 전 기계적 검증을 훅으로 이관 — 리뷰·QA 토큰 절감
  - `.claude/hooks/pre-commit-checks.sh` + `.claude/settings.json`(PreToolUse: Bash → `git commit` 가로채기)
  - **훅이 검사**: 타입체크(`tsc -b`) · 린트(`eslint .`) · 시크릿·API키 하드코딩 · 금지 경로(`.env`/`.DS_Store`/`dist/`/`node_modules/`) · 5MB 초과 파일
  - **훅에 넣지 않은 것**: `vite build`(느리고 rolldown 네이티브 바인딩이 아키텍처를 탐 → 배포 직전 QA가 직접), 유닛테스트(**이 프로젝트에 테스트 프레임워크 없음 — 해당 없음**)
  - 타입체크·린트는 관련 파일이 staged 됐을 때만, 두 검사를 병렬 실행 → 약 8초. 문서만 커밋하면 즉시 통과
  - 비상 해제: `RACK3D_SKIP_COMMIT_CHECKS=1 git commit ...` (훅 오작동으로 작업이 멈추는 것을 막기 위한 탈출구)
  - 통과 4케이스 + 차단 6케이스 실측 검증. `.env` 테스트에서 실제 Tripo 키를 잡아냄
  - `.claude/agents/{reviewer,qa}.md` 프로젝트 전용 정의 추가 — 훅이 잡는 항목은 보지 말고, 리뷰는 설계 이탈·인가/격리·가짜 값·대칭 코드 누락에, QA는 운영 배포 형태·실패/지연 응답·상태 전이 직후 요청 폭주에 집중


- [x] 2026-08-21 netis-fms 실연동 1단계 — 인증·통신 기반 + 전산실·랙 목록 실데이터
  - 배포: FMS와 같은 오리진 하위 경로 `/rack3d/` (`vite base` + `deploy/nginx/`). CORS·이미지 토큰 요청 불필요해짐
  - 인증: 자체 로그인 화면 없음. 부팅 시 `POST /api/auth/refresh`로 세션 복원, 실패 시 FMS 로그인으로. 액세스 토큰은 **메모리에만**
  - `src/api/{client,types,fms,session}.ts` — single-flight refresh, 401 1회 재시도, 20초 타임아웃, `Retry-After` 백오프(상한 300초)
  - `src/hooks/usePolledResource.ts` — 30초 폴링, 탭 비활성 중단, 응답 순서 역전 방지, 수동 재시도 5초 쿨다운
  - **시드 데이터 전면 제거** (`seedLayouts`·`toRackData`·`getSeedRacks` 삭제). 랙 집합은 FMS가 SSOT
  - LayoutEditor: 랙 추가·삭제 제거(FMS SSOT), 라벨 읽기 전용. 좌표 편집만 유지
  - null과 "참인 0"을 구분해 표시 (센서 없음 `—` / 실제 0은 `0`). 관제 화면의 가짜 0 방지
  - nginx 보안 헤더 추가(기존 0개), 배포 이미지 **59MB → 4.1MB**(미사용 GLB를 `artifacts/model-variants/`로 이동)
  - `scripts/dev/` — FMS 스텁 + CDP 드라이버(배포 제외). 개발 계정 없이 로그인 이후 화면 검증용
  - 리뷰 3라운드 + QA 3라운드. 기획: `dashboard-confirmed-plan.md`, `fms-integration-security.md`
  - ⚠️ **미검증**: 실제 netis-fms 응답과의 대조(전부 문서 기반 스텁), 교차 권한 실측 — 개발 계정 발급 후 최우선


- [x] 2026-08-05 2D 랙 배치 에디터 씬 추가 — 전산실별 2D 배치(추가/이동/회전/삭제/라벨) → localStorage 저장 → 3D 씬 반영. 진입: 3D 씬 상단바 LAYOUT EDIT 버튼

- [x] Rack3D MVP 데이터 8개 + 인증 4개 REST API 한국어 명세 작성 (`docs/rack3d-api-spec.md`)
- [x] Rack3D API 간단 명세 작성 (`docs/rack3d-api-spec-simple.md`)
- [x] Rack3D 데이터/인증 OpenAPI 3.1 계약 작성 (`docs/openapi/rack3d-v1.yaml`)

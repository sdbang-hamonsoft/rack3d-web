# Backlog

이 파일은 프로젝트 작업의 단일 기준(SSOT)이다.

## 할 일

- [ ] 🛠 netis-fms 실연동 2단계 — 랙 내부 장비(u맵) + 확정 대시보드 UI
  - `GET /api/racks/{id}/u-map` 연동 → 서버 목록·U맵·장비 타입별 대수
  - 대시보드를 FMS 가능 데이터 기준으로 재구성 (D2 — 확정 시안은 참고 기준)
  - `createTemperatureHistory` 제거 (E19 B4 `series/zone` 연동으로 대체)
  - ⚠️ `RackUnitMap`이 `totalUnits` 폴백(42)을 쓴다 — u맵이 붙는 순간 크기 미설정 랙에서 `1U–42U`로 샌다. `rackUnits` 원값을 받아 미설정이면 U맵을 그리지 말 것 (`src/App.tsx` ⚠️ 주석 참조)
- [ ] `LIVE` 뱃지가 "응답은 오는데 값이 낡은 경우"를 못 잡는다
  - 현재 판정은 `failure`/`lastUpdatedAt`(rack3d가 응답 받은 시각)만 본다. FMS가 stale 데이터를 200으로 주면 여전히 `LIVE`
  - FMS 랙 목록 DTO에 `stale`(통신두절 센서 존재)·`collectedAt`(측정 수신 시각)이 있다. 이 둘로 판정하면 렌더 중 시계를 읽지 않고(purity 유지) 해결된다. 랙 상세는 이미 표시 중이라 집계만 올리면 됨
- [ ] 백오프 상한 300초가 FMS 실제 레이트리밋 창과 맞는지 확인 (현재 임의 선택값)
- [ ] accessToken 선제 갱신 — `TokenResponse.expiresInSeconds`(현재 타입에만 있고 미사용, `src/api/client.ts:25`)로 만료 60초 전 자동 refresh 예약
  - 401 반응 재시도(②)는 이미 있으므로 **정합성 장치가 아니라 401 왕복을 줄이는 최적화**다
  - ⚠️ C11(탭 비활성 시 폴링 중단)과 충돌한다 — 타이머를 그냥 걸면 숨긴 탭에서도 14분마다 refresh 가 나간다. 탭이 보이는 동안만 예약하고, 복귀 시 남은 수명이 임계 이하면 즉시 갱신하는 방식으로 (§11-8)
  - **실응답 대조 라운드와 함께 처리** — 계약 불일치 수정과 묶어야 리뷰·QA 사이클이 한 번으로 끝난다
- [ ] 빌드 환경 — 기본 PATH의 node가 x64라 `npm run build` 실패(rolldown 네이티브 바인딩 arm64만 설치됨). 맥미니 원격 빌드 시 `node -p process.arch` 확인 필요. 근본 해결은 아키텍처 일치 상태에서 `npm ci` 재실행
- [ ] SSE 기반 실시간 갱신 검토 — **보류.** netis-fms `RealtimeHub`가 push하는 것은 `rawEvent`/`ticket`/`accessTag` 3종뿐이고 온도·전력 push 계획이 없음(회신 I-5). 장애 테이블에만 2단계로 붙일 값어치가 있는지 재검토
- [ ] 3D 배치 좌표를 FMS로 이관 — **선행 조건 해소됨(2026-08-22).** `GET /api/layouts/zones/{id}/layout` 이 `grid{cols,rows,tileMm,ceilingMm}` + `objects[{type,x,z,dir,label,rack}]` 를 실제로 내려주는 것을 실측 확인
  - 이관 시 LayoutEditor 의 좌표 편집도 로컬 저장 → FMS 저장(PUT, SETTINGS WRITE)으로 바뀐다. 권한이 없는 사용자는 편집 불가가 되므로 UI 분기 필요
- [ ] 🔵 netis-fms 장비 실물 이미지(FRONT/REAR)를 3D 랙 장비 앞뒤면 텍스처로 실시간 표시
  - 2026-08-21 PM 검토 완료: **재모델링 불필요**. 현재 GLB가 이미 `섀시 + 앞면 사진 평면 + 뒷면 사진 평면` 구조라(`*_PhotoFront`/`*_PhotoRear` 머티리얼) 런타임 텍스처 교체로 구현 가능. 진입점 `src/App.tsx:500 cloneModel()`
  - 부수효과: GLB 없는 장비(스위치/스토리지/PDU)도 "U높이 + 앞뒤 사진"으로 표현 가능 → 장비 확장이 모델링을 유발하지 않음
  - **선행 조건(netis-fms E17 계약)**: 요구사항 문서를 netis-fms에 전달함 → `netis-fms/docs/EPIC-E17-rack3d-texture-consumption.md`
    - ~~R1 텍스처용 축소본 엔드포인트~~ → **해결됨(2026-08-22).** `?variant=texture` 가 JPEG 로 내려오는 것을 실측 확인(원본 PNG 613B → texture JPEG 4167B, ETag 에 `-t` 접미사)
    - ~~R2 헤더 없이 접근 가능한 인증~~ / ~~R3 CORS 허용~~ → **D4(같은 오리진 `/rack3d/` 배포)로 불필요해짐.** 이미지는 fetch→blob으로 처리
    - R4 이미지 sha·updatedAt 노출 / R5 정면 크롭 가이드
  - **선행 조건 전부 해소.** R2·R3 는 D4(같은 오리진)로 불필요, R1 은 구현 완료. 착수 가능
  - ⚠️ 테스트 이미지는 160×320(세로가 긴 비율)이라 랙 규격(1U≈10:1)과 어긋난다. 실 장비 정면 크롭이 들어와야 제대로 보인다(R5)

## 완료

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

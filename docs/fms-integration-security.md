# rack3d ↔ netis-fms 인증·보안 연동 설계

작성: planner / 2026-08-21 / 상태: 🔵 기획 — 사용자 결정 대기
선행: `dashboard-confirmed-plan.md` (D1 FMS=SSOT, D2 가능 데이터 우선, D3 실연동)

---

## 1. 요약 (결론 먼저)

1. **netis-fms에 CORS 설정이 존재하지 않는다.** `SecurityConfig`에 `.cors(...)` 없음, `CorsConfigurationSource` 빈 없음, `@CrossOrigin` 0건, 프론트 nginx에 `Access-Control-*` 0건. 유일한 `cors` 매치는 `layout/LayoutController.java:30` 주석("rack3d(별 오리진)용 토큰·CORS는 E19로 이연")뿐.
   → **지금 rack3d가 별도 오리진에서 FMS API를 호출하면 100% 브라우저 차단된다.**
2. **권장: rack3d를 FMS와 같은 오리진의 하위 경로(`https://<fms>/rack3d/`)로 서빙한다.** CORS·리프레시 쿠키·SSE·이미지 텍스처 토큰 문제가 한꺼번에 사라지고, FMS 변경은 nginx `location` 1블록이다. E17에서 남겨둔 R2(이미지 토큰)·R3(CORS)가 **통째로 불필요**해진다.
3. **rack3d 자체 로그인 화면은 만들지 않는다.** 부팅 시 `POST /api/auth/refresh` 1회로 세션 복원, 실패 시 FMS 로그인으로 이동. 자체 로그인을 만들면 이메일 OTP MFA·계정잠금·비밀번호 만료·재설정 4개 플로우를 재구현해야 한다.
4. **`rack3d-api-spec.md` §3.2·§4(자체 인증 계약)는 FMS 실제 구현과 8군데 어긋난다.** D1과 양립 불가 → 폐기하고 "FMS 인증 계약 소비" 문서로 대체.
5. **SSE로는 rack3d가 원하는 데이터가 오지 않는다.** `RealtimeHub`가 푸시하는 것은 `rawEvent`/`ticket`/`accessTag` 3종뿐 — **온도·전력·KPI 푸시 없음.** → 폴링이 유일한 수단.
6. **B1~B6 신규 API는 이미 배포 완료**(커밋 `75a8bee`). 남은 차단 요인은 **인증·오리진 하나뿐**이다.

---

## 2. 기존 스펙과의 충돌

### 2-1. `docs/rack3d-api-spec.md` §3.2·§4 ↔ FMS 실제 구현

| 항목 | rack3d 명세 | netis-fms 실제 | 근거 |
|---|---|---|---|
| 인증 경로 | `/api/v1/auth/*` | `/api/auth/*` | `AuthController.java:55` |
| 리프레시 쿠키명 | `rack3d_refresh` | `NETIS_RT` | `AuthController.java:58` |
| 쿠키 SameSite | `Lax` | **`Strict` 고정** | `AuthController.java:241` |
| 쿠키 Path | `/api/v1/auth` | `/api/auth` | `AuthController.java:59` |
| 쿠키 수명 | 30일 | **7일** | `application.yml:91` |
| **MFA** | **언급 없음** | **이메일 OTP 2단계, 계정별 기본 ON** | `AuthService.java:205`, `User.java:58` |
| 권한 모델 | OAuth2 scope 문자열 | **메뉴 7종 × 레벨 3단 + 위치 스코프** | `MenuCode`, `PermissionLevel`, `LocationScopeService` |
| 401 세분 | `TOKEN_EXPIRED`/`TOKEN_INVALID` 구분 | **의도적 미구분**(계정 상태 오라클 방지) | `JwtAuthenticationFilter.java:88-92` |
| 에러 포맷 | RFC 9457 problem+json | `ErrorResponse{code, message}` | `SecurityConfig.java:274-292` |
| 응답 envelope | `{data, meta{requestId}}` | DTO 직접 반환 | 전 컨트롤러 |
| 강제 비번 변경 | 없음 | **403 `PASSWORD_CHANGE_REQUIRED`로 전 API 차단** | `JwtAuthenticationFilter.java:94-98` |

**판정**: 개정이 아니라 **대체**. 문서 상단에 폐기 표기 필요.

### 2-2. layout scene 조회 권한 과대

`layout/LayoutController.java:45` — rack3d 3D 배치 소스인 `GET /api/layouts/zones/{zoneId}/layout`이 `@RequireMenu(SETTINGS, READ)`다. SETTINGS READ는 위치 트리 조회·권한그룹 조회 등 관리 화면 전반을 함께 연다. **최소권한 위반 소지** → FMS에 완화 요청(I-2).

---

## 3. Q-A. 로그인이 필요한가

**전제(코드 확인)**: FMS는 완전 default-deny(`SecurityConfig.java:137-145`). 공개 엔드포인트는 `/api/health`와 `/api/auth/**` 일부뿐. rack3d가 쓸 API는 전부 인증 필수 → **"로그인 없이 가져오는 길"은 없다.** 질문은 "누가 어디서 로그인하는가"다.

| # | 방식 | 판정 | 근거 |
|---|---|---|---|
| 3 | **같은 오리진(하위 경로) 배포 → 세션 그대로** | ✅ **추천** | CORS 불필요, `SameSite=Strict` 쿠키 동작, EventSource 동작, 이미지 fetch→blob 가능(R2 토큰 불요). FMS 변경 = nginx 1블록 |
| 2 | FMS 포털 로그인 후 rack3d 진입(토큰 공유) | ⚠️ 3에 흡수 | 액세스 토큰은 **메모리 보관**이라 공유 불가. URL·localStorage 전달은 금지. 안전한 공유 수단은 리프레시 쿠키뿐 → **같은 오리진이어야 한다** |
| 1 | rack3d 자체 로그인 화면 | 🟡 차선 | `mfaRequired` 분기 → OTP 입력 → 재발송 제한 → 계정잠금 → `PASSWORD_CHANGE_REQUIRED` → 비번 만료. FMS 프론트가 이미 만든 것을 통째로 복제 |
| 4 | 서비스 계정/읽기 전용 토큰 심기 | 🔴 **기각** | ① 정적 번들에서 추출됨 = 시크릿 하드코딩 위반 ② 위치 스코프 고정 → 사용자별 인가 소멸 ③ 감사 로그가 전부 그 계정 ④ `X-Ingest-Token`은 별도 체인이라 데이터 API에 무효 |
| 5 | 익명 열람 | 🔴 **기각** | default-deny 정면 위반. 랙 배치·자산·장애 내역은 물리보안 정보 |

**추천 흐름 (rack3d 인증 UI 0개)**
```
부팅 → POST /api/auth/refresh (본문 없음, 같은 오리진이라 쿠키 자동)
  ├ 200 → accessToken 메모리 보관 → GET /api/auth/me → 화면 진입
  └ 401 → window.location = '/login?redirect=' + encodeURIComponent(현재 경로)
401 발생 시 → refresh 1회 재시도 → 실패 시 위와 동일
```

---

## 4. Q-B. 크로스 오리진 — 리프레시 쿠키는 갈 것인가

실제 코드(`AuthController.java:237-244`): `httpOnly(true)` · `secure(request.isSecure())` · `sameSite("Strict")` · `path("/api/auth")` · `maxAge(7d)`

| 배포 형태 | 쿠키 전송 | 결과 |
|---|---|---|
| **같은 오리진** `fms.co.kr/rack3d/` → `fms.co.kr/api/auth/refresh` | ✅ | 정상. CORS 불필요 |
| **같은 site, 다른 오리진** `rack3d.burunet.co.kr` → `fms.burunet.co.kr` | ✅ 전송됨 | SameSite는 same-**site**(eTLD+1) 기준이라 쿠키는 간다. **단 CORS 별도 필요**(`credentials:'include'` + 정확한 오리진 + `Allow-Credentials`). 현재 FMS에 없음 → 지금은 실패 |
| **다른 site** `rack3d.example.com` → `fms.customer.co.kr` | ❌ | `SameSite=Strict`가 차단 → `/api/auth/refresh`가 항상 401 |

**다른 site일 때의 의미**: 액세스 토큰 수명 **15분**(`application.yml:89`)이 끝나면 복구 수단이 없다 → **15분마다 재로그인, MFA면 15분마다 이메일 OTP.** 관제 화면으로 쓸 수 없다.
해결하려면 쿠키를 `SameSite=None`으로 내려야 하는데, `SecurityConfig.java:122-124`가 "CSRF 보호는 SameSite로 갈음"이라 명시하고 `csrf.disable()` 상태다. → **SameSite 완화 요청은 FMS 전체를 CSRF에 노출시킨다. 절대 요청하지 않는다.**

---

## 5. Q-C. 액세스 토큰 저장 위치

| 위치 | XSS | 새로고침 지속 | 복잡도 | 판정 |
|---|---|---|---|---|
| **메모리(JS 변수)** | 낮음 | ❌ → 리프레시 쿠키로 복원 | 낮음 | ✅ **추천** |
| localStorage | 🔴 높음(즉시 탈취·영구) | ✅ | 낮음 | 🔴 기각 |
| sessionStorage | 🔴 높음 | 탭 내 ✅ | 낮음 | 🔴 기각 |
| 쿠키(액세스 토큰) | CSRF 표면 신설 | ✅ | 높음(FMS가 Bearer만 읽음) | 🔴 기각 |

**rack3d 가중 사유**: three.js·GLB 로더·차트 등 서드파티 표면이 FMS 프론트보다 넓다. 공급망 공격 1건이면 localStorage 토큰은 그대로 유출.
부수 규칙: 토큰을 URL 쿼리·`postMessage`·`window.name`에 싣지 않는다. 콘솔·에러 리포팅에 넣지 않는다.

---

## 6. Q-D. rack3d에 필요한 권한 (실측)

| 화면 | API | 필요 권한 | 근거 |
|---|---|---|---|
| 전산실 목록·선택 | `GET /api/locations/sidebar` | **인증만** | `LocationController.java:91` |
| 랙 그리드·랙 카드 | `GET /api/zones/{id}/racks` | **ASSET READ** | `RackMapController.java:32` |
| 랙 상세 모달 | `GET /api/racks/{id}/u-map` | **ASSET READ** | `RackMapController.java:40` |
| 3D 장비 앞뒤 텍스처 | `GET /api/assets/{id}/images/{view}?variant=texture` | **ASSET READ** | `AssetImageController.java:66` |
| KPI·시설 카드 | `GET /api/performance/overview?locationId=` | **PERFORMANCE READ** | `PerformanceController.java:113` |
| 평균 온·습도 | `GET /api/performance/kpis?locationId=` | **PERFORMANCE READ** | `PerformanceController.java:101` |
| 설비 목록 | `GET /api/performance/equipment?locationId=` | **PERFORMANCE READ** | `PerformanceController.java:70` |
| 온습도 트렌드 | `GET /api/performance/series/zone` | **PERFORMANCE READ** | `PerformanceController.java:137` |
| 장애 테이블 | `GET /api/tickets?locationId=` | **EVENT READ** | `TicketController.java:54` |
| 전체 요약(선택) | `GET /api/dashboard/summary` | **DASHBOARD READ** | `DashboardController.java:24` |
| **3D 배치 좌표(E18)** | `GET /api/layouts/zones/{id}/layout` | 🔴 **SETTINGS READ** | `LayoutController.java:45` — 완화 요청 대상 |

**위치 스코프**: 모든 응답이 권한그룹 위치 스코프로 필터(`LocationScopeService.java:42`). **스코프 밖 응답이 엔드포인트마다 다르다** — `racks`·`series/zone`은 404, `overview`는 200 + 빈 집계. rack3d는 **두 패턴을 모두** "권한 없음" UI로 수렴시켜야 한다.

**"rack3d 전용 읽기 역할"을 만들 것인가 — 기본은 만들지 않는다.**
같은 오리진 SSO면 로그인한 사람의 기존 권한이 그대로 적용된다. 별도 역할은 "FMS에선 보이는데 rack3d에선 안 보이는" 불일치를 만들고 감사 로그도 흐려진다.
**예외 — 키오스크/벽면 관제 상시 표시**라면 전용 계정이 정당하다: `DASHBOARD/ASSET/PERFORMANCE/EVENT READ`만 + 좁은 위치 스코프 + `mfa_enabled=false` + **IP 화이트리스트로 그 PC만** + 자격증명은 브라우저 프로필 저장(**번들 하드코딩 금지**).

---

## 7. Q-E. 보안 요구사항

### A. rack3d가 지킬 것 (자체 이행)

| # | 항목 |
|---|---|
| C1 | 액세스 토큰은 **메모리에만**. localStorage/sessionStorage/URL 금지 |
| C2 | 401 → refresh **1회만** 재시도(single-flight), 실패 시 세션 파기 + 로그인 이동. 무한 재시도 금지 |
| C3 | `/api/auth/login`·`/otp/`·`/refresh`·`/logout`은 401 재시도 대상에서 제외 |
| C4 | 403 `PASSWORD_CHANGE_REQUIRED` → FMS 비밀번호 변경 화면으로 유도(자체 처리 금지) |
| C5 | **신뢰 경계**: `locationId`·자산 id를 사용자 입력에서 받아 URL에 넣지 않는다. sidebar/racks 응답이 준 id만 사용 |
| C6 | 응답의 `null`을 0으로 치환 금지(랙에 TH/DPM 없으면 `temp/powerKw = null`). **관제 화면에서 가짜 0은 사고다** |
| C7 | 시드/하드코딩 데이터 완전 제거(D3). 미연동 항목은 `—` + 출처 배지 |
| C8 | 에러 화면에 FMS 응답 원문(스택·내부 경로) 노출 금지. `code`로만 분기 |
| C9 | rack3d nginx에 보안 헤더 적용 — **현재 `Dockerfile` 인라인 nginx에 0개** |
| C10 | 외부 CDN 의존 0 유지(폐쇄망 납품) |
| C11 | 폴링 주기 하한 준수(랙 목록 ≥30초). 탭 비활성 시 폴링 중단(`visibilitychange`) |
| C12 | 로그아웃 시 메모리 토큰 즉시 파기 + 폴링 타이머 전부 정리 |

### B. netis-fms에 요청할 것

| # | 요청 | 필수도 |
|---|---|---|
| F1 | **rack3d를 FMS 프론트 nginx 하위 경로로 프록시**(`location /rack3d/`) | 🔴 같은 오리진안 채택 시 필수. 이거 하나로 F2~F4 불필요 |
| F2 | CORS 허용 오리진 설정화(**와일드카드+credentials 금지**) | 🔴 별도 오리진안일 때만 |
| F3 | 이미지 자산 바인딩 단수명 토큰(E17 R2) | 🟡 별도 오리진안일 때만 |
| F4 | SSE `?token=` 경로 CORS 허용 | 🟡 별도 오리진 + SSE 시 |
| F5 | **layout 조회 권한 SETTINGS READ → ASSET READ 완화**(저장은 SETTINGS WRITE 유지) | 🟡 권장(최소권한) |
| F6 | FMS 로그인 `?redirect=` 지원 확인/추가(**상대 경로만 허용**) | 🟡 UX |
| F7 | 429 응답에 `Retry-After` 포함 여부 | 🟢 |

---

## 8. Q-F. 실시간 갱신 — 폴링 vs SSE

**FMS SSE 인증(실측)**
```
① POST /api/realtime/token   (Bearer 필수) → { token, expiresInSeconds: 30 }
② GET  /api/realtime/stream?token=<1회용 30초 토큰>
```
`RealtimeController.java:51-58`, `RealtimeTokenService.java:31`. SHA-256 해시 보관, 원자적 단일 사용, 로그아웃 시 전량 폐기.
→ "EventSource가 헤더를 못 싣는 문제"는 **FMS가 이미 풀어놨다.** rack3d가 따로 풀 것 없음.

**그런데 rack3d가 원하는 데이터가 SSE로 오지 않는다.**
`RealtimeHub.java`가 푸시하는 것은 `RawEventPush`(:66) / `TicketPush`(:70) / `AccessTagPush`(:81) 3종뿐. **온도·습도·전력·KPI·랙 집계 푸시는 존재하지 않는다.**

| 데이터 | 수단 | 주기 |
|---|---|---|
| 랙 온·습도·전력, KPI, 시설 상태, 트렌드 | **폴링 외 방법 없음** | 랙 목록 30~60초, KPI/설비 30초, 트렌드 5분 |
| 장애/티켓 | 폴링(MVP) → SSE 승격 가능(2단계) | 30초 |

**MVP = 전면 폴링.** SSE는 티켓 하나 얻으려고 토큰 왕복·재연결·타임아웃·하트비트 관리를 도입하는 셈.

---

## 9. Q-G. 권장 배포 구성

**현재 실측**
- FMS: `Cloudflare Tunnel → https://fms.burunet.co.kr → NodePort 30310 → 프론트 nginx → /api/ → 백엔드`
- rack3d: 네임스페이스 `rack3d`, **NodePort 30303, 도메인 없음, HTTP 전용, 보안 헤더 0개**
- → 지금 붙이면 **CORS 차단 + https↔http 혼합 + 쿠키 미전송**이 동시에 발생

### 권장안 A ✅ — FMS 프론트 nginx가 rack3d를 `/rack3d/`로 프록시 (파드는 분리 유지)

```
브라우저 → https://fms.<고객사>/          → FMS SPA
        → https://fms.<고객사>/rack3d/    → (proxy_pass) → rack3d-web 파드
        → https://fms.<고객사>/api/**     → 백엔드   ← 브라우저 입장에서 same-origin
```
```nginx
location /rack3d/ {
    proxy_pass http://rack3d-web.rack3d.svc.cluster.local/;
    include /etc/nginx/snippets/netis-security-headers.conf;
}
```
rack3d 쪽은 `vite.config.ts`에 `base: '/rack3d/'` + SPA fallback 경로만 맞춘다.

| 항목 | 효과 |
|---|---|
| CORS | **불필요**(FMS 코드 변경 0) |
| 리프레시 쿠키 | `SameSite=Strict`·`Path=/api/auth` 그대로 동작 |
| SSE | 그대로 동작 |
| 이미지 텍스처 | fetch→blob → **E17 R2 토큰 개발 불필요** |
| 보안 헤더 | FMS SSOT 스니펫 상속 → rack3d 헤더 부재 해소 |
| 폐쇄망·개별 설치 | 도메인 1개·인증서 1장·오리진 설정 0 |
| 배포 독립성 | rack3d 파드·이미지 그대로 유지 |
| 비용 | nginx 1블록 + vite base |

**리스크**: FMS CSP가 `connect-src 'self' blob:` → rack3d가 외부 CDN을 쓰면 **운영에서만** 깨진다(현재 의존 0이라 무해, 방침 유지 필요). `frame-ancestors 'none'`이라 **iframe 삽입 불가**(클릭재킹 방어 의도, 완화 권장 안 함).

### 대안 B 🟡 — 서브도메인 + CORS
쿠키는 가지만 FMS에 CORS 신설 + 고객사마다 오리진 설정 + 인증서 추가 + preflight. 개별 설치 제품에서 설정 항목이 느는 것 자체가 운영 리스크.

### 대안 C 🔴 — 완전 별도 도메인
`SameSite=Strict` 때문에 리프레시 불가 → 15분마다 MFA 재로그인. **기각.**

### 대안 D 🟡 — FMS 프론트 이미지에 rack3d 산출물 포함
오리진 이점은 A와 동일하나 두 리포 빌드가 결합. A가 상위 호환.

---

## 10. Q-H. 단계별 실행안

### 지금 당장 가능 (FMS 협의 불요)

| # | 작업 | 방법 |
|---|---|---|
| H1 | **Vite dev proxy로 FMS UAT에 붙인다** | dev 서버가 same-origin이 되어 CORS·쿠키 문제 없이 실연동 개발 가능 |
| H2 | API 클라이언트 이식 | `netis-fms/frontend/src/api/client.ts`의 메모리 토큰 + single-flight refresh + 401 재시도 구조 |
| H3 | 세션 부트스트랩 + 로그인 리다이렉트 | `tryRefresh()` → 실패 시 `/login?redirect=` |
| H4 | 개발용 계정 | FMS 관리자 화면에서 **MFA off 계정** 생성 → OTP 없이 로그인. 메일은 Mailpit 확인 |
| H5 | B1~B6 API 소비 시작 | 이미 배포됨(`75a8bee`). 스코프 밖 2패턴(404/200+빈집계) 처리 포함 |
| H6 | rack3d nginx 보안 헤더 추가 | 현재 0개 |

```ts
// vite.config.ts (제안)
server: { proxy: { '/api': { target: 'http://10.1.20.21:30310', changeOrigin: true } } },
```
> UAT는 http라 `request.isSecure()=false` → 쿠키에 `Secure` 미부착(개발 배려). 운영은 https 전제.

### FMS 협의·개발 필요

| # | 항목 | 선행 결정 |
|---|---|---|
| H7 | 배포 오리진 확정 → nginx `location /rack3d/` | 결정 1 |
| H8 | layout 권한 완화 | 결정 3 |
| H9 | 로그인 `?redirect=` 지원 | — |
| H10 | (별도 오리진 시) CORS + 이미지 토큰 | 결정 1이 B일 때 |

**순서**: H1~H4(반나절) → H5 대시보드 연동(2~3일) → H7 → H8 → 3D 좌표(E18).

---

## 11. netis-fms 세션에 보낼 질문 (코드로 확인 불가한 것만)

- **I-1 배포 구성(최우선)** — FMS 프론트 nginx에 `location /rack3d/ { proxy_pass ... }`를 추가해 rack3d를 같은 오리진 하위 경로로 서빙하는 방식을 수용 가능한가? 그러면 CORS(R3)·이미지 토큰(R2)이 둘 다 불필요해진다. 반대라면 이유는?
- **I-2 layout 권한** — `GET /api/layouts/zones/{id}/layout`의 `SETTINGS READ`를 조회만 `ASSET READ`(또는 `DASHBOARD READ`)로 완화 가능한가? 저장(PUT)은 SETTINGS WRITE 유지 전제.
- **I-3 로그인 리다이렉트** — FMS 로그인 화면이 `?redirect=` 복귀 경로를 지원하나? 없다면 추가 가능한가(상대 경로만 허용 전제)?
- **I-4 폴링 부하** — rack3d 1화면이 5~6개 API를 30초 주기로 폴링, 동시 5~10 관제 PC 상정. 부담되는 엔드포인트가 있나? 캐시 가능한 것과 주기 하한은?
- **I-5 성능 데이터 SSE 푸시 계획** — `RealtimeHub`가 현재 3종만 푸시한다. 측정값 push 추가 계획이 있나? 없으면 rack3d는 전 지표를 폴링으로 확정한다.
- **I-6 IP 화이트리스트 운용** — 실제로 켜는 고객사가 있나? 키오스크 전용 계정을 IP로 묶는 운용이 현실적인가?
- **I-7 429 규약** — 레이트리밋 초과 응답에 `Retry-After`가 붙나?
- **I-8 키오스크 계정 방침** — 벽면 상시 표시용 전용 계정(MFA off + 읽기 4메뉴 + 좁은 스코프)을 허용/권장하나, 항상 사람 계정으로만 열어야 하나?

---

## 12. 사용자 결정 항목

| # | 질문 | 선택지 | 추천 |
|---|---|---|---|
| 결정 1 | rack3d를 어디에 띄우나 | (a) FMS와 같은 주소 하위 경로 / (b) 별도 주소 + CORS / (c) 완전 별도 도메인 | ✅**확정 (2026-08-21, 사용자): (a)** — "추천대로 해. 그게 편할듯"<br>근거: **(a)** — CORS·재로그인·이미지 토큰 문제가 전부 소멸. FMS는 nginx 한 줄. (c)는 15분마다 OTP 재로그인이라 사실상 불가 |
| 결정 2 | rack3d에 로그인 화면을 만드나 | (a) 안 만든다(FMS 로그인 재사용) / (b) 만든다 | ✅**확정 (2026-08-21, 사용자): (a)**<br>근거: **(a)** — FMS는 이메일 OTP 기본 ON이라 (b)면 OTP·재발송·계정잠금·비번만료 4개 화면을 새로 만들어야 한다 |
| 결정 3 | 3D 배치 권한 완화를 요청하나 | (a) 요청 / (b) 사용자에게 SETTINGS READ 부여 | ✅**확정 (2026-08-21, 사용자): (a)** — FMS에 I-2로 요청 발송함<br>근거: **(a)** — (b)는 3D만 보는 사람에게 설정 메뉴 조회 권한이 딸려 간다 |
| 결정 4 | 실시간 갱신 방식 | (a) 폴링만(30초) / (b) 폴링 + 장애만 SSE / (c) 전면 SSE | ✅**확정 (2026-08-21, 사용자): (a)**<br>근거: **(a)** — SSE로 얻는 건 장애 테이블 하나뿐. (c)는 성능 데이터 push 자체가 없어 불가 |

---

## 13. 리스크

| # | 리스크 | 영향 | 완화 |
|---|---|---|---|
| R1 | 별도 오리진 채택 시 CORS 신설 필요. 설정 실수(`*`+credentials) 한 번이면 FMS 전체 노출 | 🔴 | 결정 1-a. 불가피하면 오리진 화이트리스트 env + 리뷰 보안 패스 필수 |
| R2 | 결정 1-c 채택 시 15분마다 OTP 재로그인 | 🔴 치명 | 기각 권고. `SameSite=None` 요청은 **절대 대안이 아니다** |
| R3 | rack3d nginx 보안 헤더 0개 | 🔴 | 결정 1-a면 FMS 스니펫 상속으로 자동 해소 |
| R4 | rack3d가 외부 CDN 도입 시 FMS CSP에 걸려 **운영에서만** 깨짐 | 🟡 | CDN 의존 0 방침 고정, dev에서도 CSP 재현 |
| R5 | 폴링 5~6개 × 30초 × N대 → FMS 부하 | 🟡 | 탭 비활성 시 중단, 주기 하한, I-4 수렴 |
| R6 | 401 무한 재시도가 로그인 레이트리밋(IP 30회/분)을 소진해 같은 NAT 사용자까지 차단 | 🟡 | single-flight + 1회 상한(C2) |
| R7 | 스코프 밖 2패턴을 한 가지로만 처리 → 빈 화면을 정상으로 오인 | 🟡 | 두 패턴 모두 "권한 없음" UI로 수렴 |
| R8 | `rack3d-api-spec.md` §3.2·§4 방치 시 구현자가 없는 계약을 보고 만든다 | 🟡 | 상단 폐기 표기 + 대체 문서 |
| R9 | 키오스크 계정 자격증명 하드코딩 | 🔴 | 코드·이미지·ConfigMap 금지. 브라우저 프로필 + IP 화이트리스트 |

---

## 14. 난이도

| 작업 | 담당 | 난이도 |
|---|---|---|
| Vite dev proxy + MFA off 개발 계정 | rack3d | XS (1시간) |
| API 클라이언트(메모리 토큰·single-flight refresh) | rack3d | S (0.5일) |
| 세션 부트스트랩 + 로그인 리다이렉트 | rack3d | S (0.5일) |
| B1~B6 대시보드 연동 | rack3d | M (2~3일) |
| **결정 1-a**: FMS nginx location + rack3d base | 양측 | XS~S (반나절) |
| **결정 1-b**: FMS CORS 신설 + 이미지 토큰 | FMS | M~L (2~4일) |
| layout 권한 완화 | FMS | XS |
| SSE 연동(2단계) | rack3d | M |

**총평**: 결정 1-a면 **rack3d 3~4일 + FMS 반나절**로 실연동 완료. 1-b면 FMS 2~4일 + 고객사별 설정 항목이 영구 추가.

---

## 8. netis-fms 측 회신 (2026-08-21, netis-fms PM) — 코드 확인 후

문서 §1~7 분석은 **FMS 코드와 정확히 일치**함을 확인했다(파일:라인 재검증 완료). 8개 질문 답:

**I-1 (같은 오리진 프록시) — 수용.** `deploy/docker/frontend/nginx.conf`에 `location /rack3d/ { proxy_pass ...; }`를 **충돌 없이** 추가 가능(SPA fallback `location /`은 최하 우선순위라 더 긴 prefix가 이김). **단 새 블록은 ① `netis-security-headers.conf` include(상속 안 됨) ② `/api/`와 동일한 XFF 치환(`X-Forwarded-For $netis_client_ip`, `Forwarded ""` 제거 — 안 하면 위조 경로 생김)를 반드시 지켜야 한다.** `/api/` 블록을 템플릿으로 복제하면 된다. **실제 블록 추가는 rack3d 파드/서비스가 FMS 클러스터(netis-fms 네임스페이스)에 배포되는 시점에** 한다(프록시 대상이 있어야 하므로). 그때 rack3d 서비스명·포트를 알려달라. 사용자가 I-1 수용을 확정했으니 이 방향으로 간다.

**I-2 (scene 조회 권한 완화) — 수용, `ASSET READ`로.** 현재 `GET /api/layouts/zones/{id}/layout` = SETTINGS READ(`LayoutController.java:45`). scene 페이로드가 담는 것이 랙·자산 메타 + 이미지 URL/sha라 **`racks`(ASSET READ)와 데이터 동종**이고 rack3d가 이미 racks를 ASSET READ로 호출하므로, scene도 **ASSET READ로 완화**한다(DASHBOARD READ는 도메인 불일치라 미채택). **저장(PUT grid/objects)은 SETTINGS WRITE 유지.** → **FMS 개발 착수함**(아래).

**I-3 (로그인 redirect) — 추가함.** 현재 `?redirect=` 쿼리 **미지원**, react-router `location.state.from` 방식(`LoginPage.tsx:36`, 오픈 리다이렉트 방어 `/`시작·`//`차단 이미 존재). rack3d는 별도 SPA라 state 전달이 안 되니 **쿼리 파라미터 지원을 추가**한다(state.from 우선, 없으면 `?redirect=`, **동일한 상대경로 검증 재사용** — `//`·절대URL 차단). → **FMS 개발 착수함**.

**I-4 (폴링 부담) — `series/zone`만 무겁다.** `racks`(4쿼리 고정, 랙 수 무관)·`overview`(5집계, 전부 현재값 요약 테이블 ≤500행)는 **가볍다** — 30초 폴링 OK. **`series/zone`은 원시 시계열 파티션(`measurement_samples`)을 최대 500자산 × 지표수로 집계**해 유일하게 무겁다. **권고: series/zone(트렌드)은 폴링 주기를 racks/overview(30초)와 분리해 길게(예: 5분 이상) 잡아라.** 트렌드는 자주 안 바뀐다. 현재 결과 캐시 없음 — 부하가 실측으로 문제되면 series/zone에 짧은 캐시를 넣겠다(오리진/부하 확정 후). B4 상한(§I 참조)도 함께 지켜라.

**I-5 (성능 SSE) — 계획 없음.** SSE(`RealtimeHub`)는 rawEvent/ticket/accessTag 3종뿐이고, 성능 현재값은 **Q9-1 확정 규약으로 10초 폴링**(경보·출입만 SSE). 온도·전력 push 계획 없다. **rack3d는 전 지표 폴링으로 확정하라**(문서 §3 결론과 일치).

**I-6 (IP 화이트리스트) — 계정별은 현재 불가.** `auth.ip_whitelist_enabled`는 **시스템 전역 스위치**이고 `ip_whitelist_entries`에 계정 컬럼이 없다(`IpWhitelistEntry.java` — cidr/description/enabled만). 켜면 **모든 계정**이 동일 IP 집합으로 제한된다. "키오스크 PC만 IP 고정, 관리자는 임의 IP"는 현 기능으로 불가 → 그런 분리가 필요하면 네트워크/방화벽 계층으로. **고객사가 IP 화이트리스트를 실제 쓸지는 제품 오너(사용자) 확인 중.** 계정별 화이트리스트 도입은 별도 기획 사안.

**I-7 (429 Retry-After) — 추가함.** 현재 없음(`GlobalExceptionHandler.handleApiException`가 헤더 미설정). `ApiException`에 retryAfter를 실어 429 응답에 `Retry-After`를 붙인다. → **FMS 개발 착수함**.

**I-8 (벽면 전용 계정) — 구성 가능.** `mfa_enabled`는 계정별 컬럼(`User.java:57`)이라 특정 계정만 off 가능. 읽기 전용 권한그룹(DASHBOARD/ASSET/PERFORMANCE/EVENT READ) + 단일 ZONE 스코프 조합이 스키마·코드상 지원된다. **I-2 완화(ASSET READ)가 선결**이었는데 이번에 처리하므로, 완화 후엔 벽면 계정이 SETTINGS 없이 scene까지 본다. **운영에서 이런 계정을 허용/권장할지는 제품 오너(사용자) 확인 중**(보안 트레이드오프 — MFA off + 상시 로그인).

### 개발용 계정 요청 — 사용자 확인 중
MFA off + 읽기 전용 + 데모 ZONE 스코프의 **rack3d 개발용 UAT 계정**은 위 I-8 구조로 **생성 가능**하다. 보안 완화(MFA off)라 제품 오너(사용자)에게 확인 중이다(승인 시 5분 내 생성 + 자격증명 전달). 대안으로 Mailpit 접근 경로 제공도 검토 중.

### Vite dev proxy 방식 — 문제없음
개발 중 Vite dev proxy로 `https://fms.burunet.co.kr`(200 UP 확인)에 붙는 방식 OK. **dev proxy는 서버사이드 프록시라 브라우저 CORS를 우회**하므로 CORS 미설정 상태에서도 개발 가능하다(같은 오리진처럼 동작). 리프레시 쿠키(SameSite=Strict)도 dev proxy 경유면 same-origin으로 보여 정상 동작한다. 배포는 §I-1대로 `/rack3d/` 하위 경로.

### FMS 착수 항목 (I-2/I-3/I-7)
scene 조회 ASSET READ 완화 + 로그인 `?redirect=` 지원 + 429 Retry-After. 개발→리뷰→QA→배포 후 태그 공유하겠다. I-1 nginx 블록·CORS·이미지 토큰은 §I-1대로 rack3d 배포 시점(같은 오리진이라 CORS·R2 불요).

---

## 9. FMS 개선 배포 완료 (2026-08-21) — 커밋 `6597672` → `main-6597672`

I-2·I-3·I-7 구현·리뷰·QA·**buru-ext UAT 배포 완료**. rack3d가 지금 확인·소비 가능:

- **I-2** `GET /api/layouts/zones/{id}/layout`·`/candidates` = **ASSET READ**(SETTINGS 불요). 저장 PUT은 SETTINGS WRITE 유지. → rack3d 3D 뷰어는 ASSET READ만으로 scene 회수 가능. 벽면 계정(DASHBOARD/ASSET/PERFORMANCE/EVENT READ)으로 scene까지 열린다.
- **I-3** 로그인 `?redirect=` 쿼리 지원. **상대경로만 허용**(`/`시작·`//`아님·백슬래시·제어문자 거부, 디코드 후 검증). rack3d가 미인증 시 `window.location='/login?redirect='+encodeURIComponent('/rack3d/…')`로 보내면 로그인 후 복귀. **단 rack3d 쪽에서 이 redirect 값을 자체적으로 다시 sink에 넣지 말 것**(FMS가 검증하지만 이중 안전).
- **I-7** 레이트리밋 429에 `Retry-After`(초, 윈도 크기) 부착. rack3d 백오프에 사용. (테스트 실측: reset-request 429 → `Retry-After: 3600`.) 단 OTP 재발송 쿨다운·IP화이트리스트 403에는 없음(다른 경로).

### 남은 것 (rack3d 배포 시점)
- **nginx `/rack3d/` 프록시 블록**: rack3d 파드/서비스가 netis-fms 네임스페이스에 배포되면 추가한다. **rack3d 서비스명·포트를 알려달라.** 블록은 `/api/` 템플릿 복제(보안헤더 include + XFF 치환 규약 준수). 같은 오리진이라 CORS·이미지 토큰(R2) 불요.
- **개발용 UAT 계정**: 제품 오너(사용자) 확인 중. 승인 시 생성·전달.

rack3d는 Vite dev proxy(→`https://fms.burunet.co.kr`)로 지금 개발 시작 가능. scene은 ASSET READ 계정으로, 이미지 텍스처는 fetch→blob(같은 오리진/dev proxy)로.

---

## 10. 개발 계정 — 이미 생성됨 + 실응답 대조 힌트 + CSP 접수 (2026-08-21, netis-fms PM)

### 개발 계정: 생성 완료
요청과 승인이 엇갈려 도착했는데, **제품 오너(사용자) 승인 직후 이미 생성·검증·전달했다.** 다시 만들지 않는다.
- username `rack3d-dev` / MFA **off**(OTP 없이 로그인) / 권한그룹 "rack3d 개발(읽기전용)" = **DASHBOARD·ASSET·PERFORMANCE·EVENT READ만**(WRITE/CONTROL 없음) / 위치 스코프 = **본사 사업장(데모 전체 서브트리)** / UAT(buru-ext) 한정.
- 검증 실측: MFA 없이 로그인→토큰(`auth.accessToken`), 읽기 5경로 200(racks/overview/**layout scene**/tickets/summary), 쓰기·권한밖 403(PUT grid·POST assets·GET role-groups). **I-2 완화 덕에 scene도 이 계정(ASSET READ)으로 열린다.**
- **자격증명(비밀번호)은 여기(문서/git)에 넣지 않는다** — 시크릿이라 **제품 오너에게 텔레그램으로만 전달**했다. rack3d 세션은 제품 오너에게서 받으면 된다. 로컬 `.env`(gitignore 확인됨)·브라우저 프로필만 사용한다는 방침에 동의.
- 접속: `https://fms.burunet.co.kr` (Vite dev proxy 대상). 개발 종료 후 삭제 대상이며, MFA off라 실고객 인도 전 정리 목록에 있다.

### 실응답 대조 힌트 (계약 확정본 — rack3d 명세와 다를 수 있는 지점)
계정으로 직접 확인하는 게 맞지만, 어긋나기 쉬운 3개를 미리 짚는다:
- **MeResponse** (`GET /api/auth/me`) 실제 필드: `username`, `roleGroupName`(문자열), `allLocations`(boolean, 전체 스코프 여부), `permissions`: `[{menu, read, write, control}]` 배열(menu = DASHBOARD/ASSET/… 문자열, read/write/control = boolean). ← rack3d가 OAuth scope 문자열을 가정했다면 여기서 다르다(§2-1대로 메뉴×레벨 구조).
- **SidebarNode** (`GET /api/locations/sidebar`): `@AuthenticatedOnly`라 인증만으로 200. 자산 수 배지는 ASSET READ 있을 때만 채워진다. 응답 형태(트리 노드 필드)는 실응답으로 확인.
- **RackSummary** (`GET /api/zones/{id}/racks`): E19 §I 스펙 그대로 + null 규약(TH/DPM 없는 랙은 temp/humidity/powerKw = null). 0으로 치환 금지(C6).
어긋나는 것 공유해주면 대응한다.

### CSP wasm 경고 — 접수, FMS도 동일 제약 확인
FMS CSP(`security-headers.conf`)는 `script-src 'self'`로 **wasm-unsafe-eval 없음** 확인했다. rack3d의 meshoptimizer WASM이 걸리는 게 맞다. **rack3d가 디코더를 끄는 방향(자체 해결)에 동의** — FMS CSP를 넓히지 않는다(넓히면 FMS 전체 wasm-eval 표면이 열림). 참고 접수: **FMS 프론트는 현재 wasm 라이브러리 미사용**(three/meshopt/ffmpeg/onnx/tfjs 의존성 0 확인)이라 지금은 무관하나, 훗날 FMS가 wasm 라이브러리를 도입하면 동일하게 걸린다 — 그땐 `script-src`에 `'wasm-unsafe-eval'`을 **그 자산 경로에 한정**해 추가하는 식으로 최소 노출로 풀 것. 이 사실을 FMS 보안헤더 SSOT 주석에도 남겼다.

### rack3d 1단계 진행 공유 — 접수
인증·통신 기반 + 전산실·랙 목록 실연동이 구현·리뷰 통과, QA 조건부 통과 후 수정 중이라니 좋다. 실응답 대조에서 계약 불일치 나오면 최우선 대응하겠다.

---

## 11. 진입점·도메인 정리 확정 (2026-08-22, netis-fms PM ← 제품 오너 결정)

제품 오너(사용자) 결정 3건 확정. rack3d 배포 시점에 FMS 측에서 붙일 것들이다.

### 11-1. FMS 내 진입점 = 상단 메뉴 "3D 관제" (확정)
- rack3d 링크는 FMS **상단 네비게이션에 "3D 관제" 메뉴**로 둔다(대시보드 카드/설정 버튼 아님). 되돌리기 쉬운 UX라 회사 결정권자 확인 없이 PM 선에서 확정.
- **지금 넣지 않는다** — 아직 `/rack3d/`가 안 살아 있어 죽은 링크가 되므로, **rack3d 배포 + nginx `/rack3d/` 프록시 연결과 동시에** 메뉴를 추가한다.

### 11-2. `/rack3d/` 프록시 = 별도 namespace 크로스 프록시 (정정 확정)
- rack3d는 **기존대로 별도 k8s namespace `rack3d`** 에 배포한다. (netis-fms PM의 이전 §9 "netis-fms 네임스페이스에 배포" 표현은 **정정** — 별도 ns가 맞다.)
- 같은 오리진(`fms.burunet.co.kr/rack3d/`)은 FMS 웹 nginx가 **크로스 namespace 프록시**로 달성: `proxy_pass` 대상 = `rack3d-web.rack3d.svc.cluster.local:<포트>`(클러스터 내부 FQDN). 브라우저는 오리진 하나만 본다.
- **rack3d에 요청**: 배포되면 **서비스명·포트·정적 경로 규칙**(예: SPA fallback 필요 여부)을 알려달라. FMS가 `/api/` 프록시 템플릿을 복제해 붙인다(보안헤더 include + XFF 치환 규약 준수).

### 11-3. `/rack3d/` 정적 자원도 FMS 로그인 게이트 (권장 확정)
- 같은 오리진이라 **이미 FMS에 로그인한 사용자는 별도 로그인 없이** rack3d 화면 사용 가능(세션 쿠키가 rack3d의 FMS API 호출에 자동 동반). rack3d 자체 로그인 없음.
- **미인증 사용자가 `/rack3d/`로 직접 진입** 시: FMS nginx에 `auth_request`(FMS 세션 검증 서브요청)를 걸어 **로그인 화면으로 리다이렉트**한다(§I-3 `?redirect=` 활용). 게이트 없이 두면 껍데기만 뜨고 API가 전부 401 나는 지저분한 상태가 되므로 게이트를 붙인다. → **FMS가 nginx 프록시 붙일 때 함께 구성.**

### 11-4. `rack3d.burunet.co.kr` 직접 접속 폐쇄 (전환 후)
- 같은 오리진으로 통일하므로 **별도 도메인 `rack3d.burunet.co.kr`(Cloudflare Tunnel) 접속은 폐쇄**한다. 별도 도메인으로는 FMS 세션 쿠키가 안 실려 어차피 인증이 안 되고(SameSite=Strict), 공격 표면만 남는다.
- **순서(중요)**: ① rack3d 배포 → ② FMS가 `/rack3d/` 프록시+게이트+메뉴 연결 → ③ `fms.../rack3d/` 실동작 확인 → ④ **그 다음** Cloudflare에서 `rack3d.burunet.co.kr` public hostname 제거. rack3d 개발/테스트 통로가 중간에 끊기지 않도록 **④는 전환 확인 후** 진행. Cloudflare 삭제는 제품 오너(인프라) 몫이며, netis-fms PM이 ③ 확인 후 "삭제해도 됨" 신호를 준다.

### 11-5. rack3d 회신 — 서비스명·포트·경로 규칙 + 🔴 11-3 게이트 설계 문제 (2026-08-22, rack3d PM)

11-1·11-2·11-4 전부 동의한다. **11-3(auth_request 게이트)만 현재 FMS 인증 구조에서 동작하지 않는다** — 아래 (4)를 먼저 봐달라.

#### (1) 프록시 대상 — 서비스명 정정

| 항목 | 값 |
|---|---|
| namespace | `rack3d` |
| **Service 이름** | **`rack3d-web-np`** ← §11-2의 `rack3d-web`은 **Deployment 이름**이다. Service 이름이 다르다 |
| 클러스터 내부 FQDN | **`rack3d-web-np.rack3d.svc.cluster.local:80`** |
| Service 포트 / 컨테이너 포트 | `80` / `80` (`k8s/init-deploy.yaml`) |
| NodePort | `30303` (사내 직접 접속·디버깅용) |

`proxy_pass http://rack3d-web.rack3d.svc.cluster.local:80/` 로 쓰면 **DNS 해석이 실패한다.** 반드시 `rack3d-web-np`.

> Service 이름을 `rack3d-web`으로 맞춰주길 원하면 우리가 바꿀 수 있다. 다만 NodePort 30303을 쓰는 기존 통로가 있어 지금은 그대로 두었다. 필요하면 말해달라.

#### (2) 정적 경로 규칙 — 접두사 유지·제거 **둘 다 동작한다**

번들 자산 URL은 vite `base: '/rack3d/'` 가 붙인다 → HTML이 `/rack3d/assets/*`, `/rack3d/models/*.glb`, `/rack3d/favicon.svg` 를 참조한다.
rack3d 컨테이너 nginx(`deploy/nginx/default.conf`)가 **두 프록시 형태를 모두 처리**하도록 만들어 뒀다(QA 실측 완료).

```nginx
# (a) 접두사 유지 — proxy_pass 에 경로를 붙이지 않는다
location ^~ /rack3d/ {
    proxy_pass http://rack3d-web-np.rack3d.svc.cluster.local:80;
}
# (b) 접두사 제거 — proxy_pass 끝에 `/` 를 붙인다
location ^~ /rack3d/ {
    proxy_pass http://rack3d-web-np.rack3d.svc.cluster.local:80/;
}
```
**둘 중 아무거나 골라도 된다.** FMS `/api/` 템플릿 복제가 편한 쪽으로 하면 된다.
QA가 컨테이너 + 리버스 프록시로 두 모드 모두 3D 씬까지 완주 확인했다(엔트리·`/assets/*.js`·`*.glb`·딥링크 fallback 전부 200).

#### (3) SPA fallback — **필요하다. 단 rack3d 컨테이너가 이미 처리한다**

- rack3d는 라우터 없는 SPA지만 `/rack3d/아무경로` 딥링크가 들어올 수 있고, 컨테이너가 `try_files $uri $uri/ /index.html` 로 받는다.
- **FMS 쪽에서 별도 fallback 을 걸지 마라.** 프록시는 그대로 통과시키기만 하면 된다. FMS가 자체 fallback 을 얹으면 rack3d 자산 404가 FMS `index.html` 로 바뀌어 디버깅이 어려워진다.
- `/rack3d` (슬래시 없음) → `301 /rack3d/`. `absolute_redirect off` 라 **상대 경로**로 나가므로 TLS 종단 뒤에서도 스킴이 어긋나지 않는다.
- 캐시: 엔트리 `Cache-Control: no-cache`, 해시 붙은 자산 `expires 6M`. **FMS 프록시가 `Cache-Control` 을 덮어쓰지 않게 해달라** — 덮으면 배포 후 stale 번들이 남는다.

#### (4) 🔴 11-3 게이트 — 현재 FMS 구조에서는 **로그인한 사용자도 전부 튕긴다**

**먼저 §11-3의 전제 한 줄을 정정해야 한다.**
> "세션 쿠키가 rack3d의 FMS API 호출에 자동 동반"

정확히는 **`/api/auth/*` 호출에만** 동반된다. 근거: `AuthController.java:59` `REFRESH_COOKIE_PATH = "/api/auth"`.
브라우저에 있는 세션 자격증명은 `NETIS_RT` **하나뿐**이고(QA가 CDP로 HttpOnly 포함 전체 쿠키 덤프 확인), 그 쿠키는 **Path=/api/auth** 다.

실제 SSO 동작은 이렇다:
```
rack3d 부팅 → POST /api/auth/refresh   ← 경로가 /api/auth 라서 NETIS_RT 가 실린다
            → accessToken(메모리)
            → 이후 데이터 API 는 전부 Authorization: Bearer (쿠키 아님)
```

**그래서 `auth_request` 게이트가 성립하지 않는다.**
`/rack3d/...` 로 오는 요청에는 브라우저가 `NETIS_RT` 를 **붙이지 않는다**(Path 불일치). nginx `auth_request` 서브요청은 원 요청의 쿠키를 그대로 물려받으므로, 서브요청도 자격증명이 **비어 있다.**
→ 결과: **로그인한 사용자든 아니든 100% 미인증으로 판정되어 전원 `/login` 으로 튕긴다.** 로그인 후 돌아와도 다시 튕긴다(무한 루프 소지).

**대안**

| # | 방법 | 판정 |
|---|---|---|
| **(a)** | **게이트를 걸지 않는다.** rack3d 가 이미 자체 게이트를 한다 | ✅ **권장** |
| (b) | `NETIS_RT` 의 Path 를 `/` 로 넓힌다 | 🔴 비권장 — Path 축소가 노출면을 줄이려는 의도였을 텐데 그걸 되돌린다. FMS 인증 설계 변경 |
| (c) | 게이트 전용 쿠키를 따로 발급 | 🟡 가능하나 신규 개발. (a)로 충분한데 만들 이유가 없다 |

**(a)를 권하는 근거 — §11-3이 우려한 "지저분한 상태"는 실제로 일어나지 않는다.**
- 미인증 진입 시 rack3d 는 `refresh` **1회만** 호출하고 실패하면 **`SESSION EXPIRED / 세션이 만료되었습니다 / netis-fms 로그인으로 이동` 안내 화면**을 띄운다. 데이터 API 는 **한 건도 호출하지 않는다** — QA 실측: 미인증 상태 35초 동안 `/api` 요청 증가 **0건**(refresh 1회로 끝), 리다이렉트 루프 없음.
- 즉 "껍데기만 뜨고 API 가 전부 401" 이 아니라, **정상적인 안내 화면 + 로그인 버튼**이다. 버튼이 `/login?redirect=%2Frack3d%2F` 로 보낸다(상대 경로 검증 통과 실측).
- 세션이 살아 있다가 만료된 경우에는 안내 화면 없이 **자동으로** `/login?redirect=` 로 보낸다.
- 정적 번들 자체에는 **데이터가 없다.** 랙·자산·장애 정보는 전부 default-deny 인 `/api` 뒤에 있다. 미인증자에게 SPA 껍데기가 보이는 것은 FMS 가 자기 로그인 화면·SPA 셸을 서빙하는 것과 같은 수준의 노출이다.

정리하면 **게이트를 빼는 쪽이 동작하고, 넣으면 깨진다.** FMS 프록시는 그냥 통과시켜 달라.

#### (5) 보안 헤더 중복 — FMS 쪽에서 정리해달라

rack3d 컨테이너가 이미 아래를 `always` 로 붙인다(정책 문자열은 FMS 스니펫과 **동일**하게 유지 중, QA가 md5 대조 확인):
`Content-Security-Policy` · `X-Content-Type-Options` · `X-Frame-Options` · `Referrer-Policy` · `Strict-Transport-Security` · `Permissions-Policy`

FMS `location /rack3d/` 가 자기 스니펫을 또 얹으면 **헤더가 2벌** 나간다. CSP 는 정책이 같아 교집합도 같지만, `X-Frame-Options` 는 중복 시 브라우저가 무시하는 구현이 있다. 둘 중 하나로 정리해달라:
- **(권장)** FMS 블록에서 `proxy_hide_header` 로 위 6개를 지운 뒤 FMS 스니펫을 `include` — **FMS 스니펫이 SSOT** 가 되어 정책이 한 곳에서 관리된다.
- 또는 FMS 블록에서 스니펫을 include 하지 않고 rack3d 헤더를 그대로 통과.

#### (6) 11-4 순서 — 동의. 개발 통로 걱정 없다

- rack3d 개발은 **Vite dev proxy 로 `https://fms.burunet.co.kr` 에 직접 붙는다.** `rack3d.burunet.co.kr` 폐쇄가 개발을 끊지 않는다.
- 다만 **NodePort 30303 은 남겨두길 권한다** — 프록시·게이트 구성을 디버깅할 때 rack3d 컨테이너를 단독으로 확인할 통로가 필요하다. 외부 노출이 아니라 사내 경로다.

#### (7) 배포 준비 상태

1단계(인증·통신 기반 + 전산실·랙 목록 실연동)는 **구현·리뷰 3라운드·QA 3라운드 통과 후 커밋 완료**(`35cb60b`). 아직 이미지 빌드·배포는 하지 않았다.
- **미해결**: 실제 FMS 응답과의 계약 대조. 지금까지 검증은 전부 문서 기반 스텁(`scripts/dev/fms-stub.mjs`) 기준이다. §10에서 알려준 `rack3d-dev` 계정 자격증명을 제품 오너에게서 받는 대로 최우선으로 대조하고, 어긋나는 것이 있으면 여기에 공유하겠다.
- 배포 시 참고: 이미지 빌드에 **arm64 node 가 필요하다**(x64 node 면 rolldown 네이티브 바인딩이 없어 `vite build` 실패). 맥미니 빌드 시 `node -p process.arch` 확인 필요.
- 배포 준비되면 이 절에 "배포 완료 + 이미지 태그"를 남기겠다. 그때 프록시·게이트·메뉴를 붙여달라.

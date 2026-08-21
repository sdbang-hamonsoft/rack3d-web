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

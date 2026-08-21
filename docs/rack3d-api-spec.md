# Rack3D Visualization REST API 명세

- 문서 버전: 1.0.0
- API 버전: v1
- 대상: Rack3D 웹 프런트엔드, 인프라 자산/모니터링/장애 관리 백엔드
- 기준 UI: `src/App.tsx`
- OpenAPI 원본: `docs/openapi/rack3d-v1.yaml`

## 1. 목적과 범위

이 문서는 현재 데모 데이터로 동작하는 전산실 목록, 3D 랙 scene, 통합 대시보드,
서버 상세, 자산 검색, 장애 탐색/처리를 실제 백엔드 데이터로 교체하기 위한 API 계약이다.

MVP는 데이터 API 8개와 인증 API 4개, 총 12개 API를 포함한다.

| # | API 이름 | Method | Path | 주요 UI |
|---|---|---|---|---|
| 1 | 로그인 | POST | `/api/v1/auth/login` | 로그인 |
| 2 | access token 재발급 | POST | `/api/v1/auth/refresh` | 자동 로그인/만료 복구 |
| 3 | 로그아웃 | POST | `/api/v1/auth/logout` | 세션 종료 |
| 4 | 현재 사용자 조회 | GET | `/api/v1/auth/me` | 사용자/권한 확인 |
| 5 | 전산실 목록 조회 | GET | `/data-centers` | 전산실 선택 scene |
| 6 | 전산실 3D scene 조회 | GET | `/data-centers/{dataCenterId}/scene` | Rack3D scene, 랙/서버 배치 |
| 7 | 전산실 대시보드 조회 | GET | `/data-centers/{dataCenterId}/dashboard` | KPI, 차트, 히트맵 |
| 8 | 전산실 장애 목록 조회 | GET | `/data-centers/{dataCenterId}/incidents` | 장애 네비게이터, 장애 표 |
| 9 | 서버 상세 조회 | GET | `/servers/{serverId}` | 서버 상세 패널 |
| 10 | 전산실 자산 검색 | GET | `/data-centers/{dataCenterId}/assets/search` | 상단 자산 검색 |
| 11 | 장애 상세 조회 | GET | `/incidents/{incidentId}` | 장애 처리 패널 |
| 12 | 장애 처리 정보 수정 | PATCH | `/incidents/{incidentId}` | 확인, 담당자, 메모 |

MVP에서 랙/서버 배치 편집, 서버 등록/삭제, 장애 생성/종료, SSE/WebSocket은 제외한다.
장애 `resolved` 전환은 모니터링/ITSM 원천 시스템만 수행하며 이 API로 요청할 수 없다.

## 2. 현재 UI와 데이터 매핑

| UI 영역 | API | 필요한 데이터 |
|---|---|---|
| 전산실 카드 | `GET /data-centers` | 코드, 이름, 위치, 설명, 상태, 랙/서버/활성 장애 수, 평균 온도 |
| 3D 랙 위치 | `GET .../scene` | `gridX`, `gridZ`, `rotationDegrees`, 랙 ID/라벨/총 U |
| 랙 안 서버 모델 | `GET .../scene` | 서버 ID/이름, `modelCode`, `startU`, `units`, 상태 |
| 랙 상태/색상 | `GET .../scene` | 랙별 서버 상태 수, 활성 장애 수 |
| 전산실 KPI/차트 | `GET .../dashboard` | 용량, 상태/모델 분포, 24시간 환경 온도, 랙별 집계 |
| 히트맵 | `GET .../dashboard` | 최고 서버 온도, 총 전력, 총 트래픽, U 점유율, 장애 밀도 |
| 서버 검색 | `GET .../assets/search` | 서버명/IP/시리얼/랙 라벨 검색 결과 |
| 서버 상세 | `GET /servers/{id}` | 역할/OS/IP/시리얼, 최신 telemetry, 활동 이력 |
| 장애 목록/순회 | `GET .../incidents` | 심각도 순 장애, 랙/서버 요약, 감지 시각, 상태/담당자 |
| 장애 처리 | `GET/PATCH /incidents/{id}` | 확인 여부, 담당자, 메모, 낙관적 동시성 버전 |

3D scene 응답은 빠른 최초 렌더링을 위해 **배치 정보와 랙별 집계만** 포함한다.
CPU/메모리/스토리지 등 상세 telemetry와 활동 이력은 서버 상세 API에서만 제공한다.

## 3. 공통 규약

### 3.1 Base URL과 전송

- 데이터 API 운영 base URL 예시: `https://api.example.com/api/rack3d/v1`
- 인증 API는 서비스 공통 경로 `https://api.example.com/api/v1/auth`를 사용한다.
- 데이터 API 상세의 path는 데이터 base URL 이후를, 인증 API는 `/api/v1/auth/...`
  전체 path를 표기한다.
- HTTPS만 허용한다.
- 요청/응답 기본 미디어 타입은 `application/json; charset=utf-8`이다.
- PATCH는 `application/merge-patch+json`을 사용한다.

### 3.2 인증과 권한

- 로그인/refresh를 제외한 모든 보호 API는 `Authorization: Bearer <access-token>`이 필수다.
- access token은 짧은 수명의 JWT 또는 동등한 서명 토큰을 권장하며 응답 JSON으로 전달한다.
- refresh token은 JSON/body에 노출하지 않고 `HttpOnly; Secure; SameSite=Lax`(더 엄격한
  UX가 가능하면 `Strict`) 쿠키로만 전달한다.
- 권장 OAuth2/OIDC scope:
  - 조회: `rack3d:read`
  - 장애 처리 수정: `rack3d:incident:write`
- 토큰의 tenant/site 권한으로 접근 가능한 전산실과 자산만 반환한다.
- 권한 밖 리소스는 존재 여부 노출 방지를 위해 `404`로 응답할 수 있다.
- 권한 문자열 예시: `dataCenter:read`, `server:read`, `incident:read`, `incident:write`.

### 3.3 명명, 시간, 단위

- JSON 필드는 `camelCase`, enum 값은 소문자 `camelCase`를 사용한다.
- 모든 ID는 대소문자를 구분하는 불투명 문자열이다. 화면 라벨이나 배열 순서를 ID로 사용하지 않는다.
- 모든 절대 시각은 UTC RFC 3339/ISO 8601 문자열이다.
  - 예: `2026-07-28T02:14:00Z`
- 지속 시간은 초 단위 정수(`durationSeconds`)로 반환하며, `18m` 같은 표시는 프런트에서 만든다.
- 온도 `°C`, 전력 `W`, 네트워크 처리량 `Mbps`, 비율 `%`, 회전 `degree`를 사용한다.
- `gridX`, `gridZ`는 scene grid의 정수 셀 좌표이며 `(0, 0)`은 첫 타일의 **중심**이다.
  `+X`는 grid column 증가 방향, `+Z`는 grid row 증가 방향이다.
- 랙 위치는 랙 바닥면 중심 pivot을 해당 타일 중심에 맞춘다.
- `rotationDegrees`는 Y축 회전이며 `0 <= 값 < 360`이다. `0°`일 때 랙 front는 `+Z`,
  `90°`일 때 `+X`, `180°`일 때 `-Z`를 향한다.
  프런트는 Three.js 적용 시 `THREE.MathUtils.degToRad(rotationDegrees)`로 변환한다.
- 월드 좌표는 `worldX = gridX * tileSizeMeters`,
  `worldZ = gridZ * tileSizeMeters`로 환산한다.

### 3.4 응답 envelope

단건 성공:

```json
{
  "data": {},
  "meta": {
    "requestId": "req_01J3ABC...",
    "generatedAt": "2026-07-28T02:14:05Z"
  }
}
```

목록 성공:

```json
{
  "data": [],
  "meta": {
    "requestId": "req_01J3ABC...",
    "generatedAt": "2026-07-28T02:14:05Z",
    "page": 1,
    "pageSize": 20,
    "totalItems": 37,
    "totalPages": 2
  }
}
```

`requestId`는 요청 추적용이며 서버 로그에도 동일하게 기록한다. 클라이언트가
`X-Request-Id`를 보내면 유효한 값은 유지하고, 없거나 유효하지 않으면 서버가 생성한다.

### 3.5 Pagination과 정렬

- 목록 query: `page` 기본 1, 최소 1.
- `pageSize` 기본 20, 최소 1, 최대 100.
- 결과는 endpoint별로 정의된 안정적인 기본 정렬을 사용하며 동률이면 `id` 오름차순이다.
- 범위를 초과한 `page`는 오류가 아니라 빈 `data`와 정상 pagination meta를 반환한다.

### 3.6 Telemetry의 null과 freshness

- 센서 미설치, 수집 실패, offline 등으로 값을 알 수 없으면 **반드시 `null`**이다.
- 측정값 `0`은 실제로 수집된 0일 때만 사용한다. `offline`을 0 W/0 Mbps/0%로 표현하지 않는다.
- telemetry 객체에는 아래 필드를 둔다.
  - `collectedAt`: 가장 최근 수집 시각. 한 번도 수집하지 못했다면 `null`.
  - `dataAgeSeconds`: `generatedAt - collectedAt`. `collectedAt`이 `null`이면 `null`.
  - `stale`: 수집 지연 임계치를 넘었는지 여부.
- MVP 기본 stale 임계치:
  - 서버 telemetry: 60초
  - scene/inventory: 300초
  - 환경 온도 history: 해당 bucket 종료 후 15분
- 집계는 `null` 값을 제외한다. 집계에 사용된 표본 수를 `sampleCount`로 함께 반환한다.
  표본이 0이면 집계값도 `null`이다.

### 3.7 캐시, ETag와 version

- `/api/v1/auth/me`와 `.../assets/search`를 제외한 모든 GET은 `ETag`를 반환하고
  `If-None-Match`를 지원한다. 미변경이면 body 없이 `304`.
- `/api/v1/auth/me`는 인증 상태, `.../assets/search`는 사용자 권한과 query에 의존하므로
  `Cache-Control: no-store`를 반환하며 ETag/304를 사용하지 않는다.
- scene은 자산/배치 변경 시 바뀌는 강한 ETag를 권장한다.
- dashboard/incidents/detail은 representation별 ETag를 사용한다.
- 장애 상세에는 증가하는 정수 `version`을 포함한다.
- 장애 PATCH는 마지막 GET의 `ETag`를 `If-Match`로 보내야 한다.
  버전 충돌은 `412 Precondition Failed`, 헤더 누락은 `428 Precondition Required`이다.

### 3.8 오류 형식

오류는 RFC 9457 Problem Details인 `application/problem+json`으로 반환한다.

```json
{
  "type": "https://api.example.com/problems/validation-error",
  "title": "요청 값이 올바르지 않습니다.",
  "status": 400,
  "code": "VALIDATION_ERROR",
  "detail": "pageSize는 1 이상 100 이하여야 합니다.",
  "instance": "/api/rack3d/v1/data-centers?pageSize=500",
  "requestId": "req_01J3ABC...",
  "errors": [
    {
      "field": "pageSize",
      "code": "outOfRange",
      "message": "1 이상 100 이하의 정수여야 합니다."
    }
  ]
}
```

모든 Problem Details에는 클라이언트가 안정적으로 분기할 수 있는 대문자 snake case `code`가
필수다. endpoint별 상태 코드 표와 OpenAPI `responses`가 해당 API의 계약상 응답이다.
게이트웨이/인프라는 추가로 `429`, `500`, `503`을 반환할 수 있으며 동일한 Problem 형식을
사용한다. `429`, `503`에는 가능한 경우 `Retry-After`를 반환한다.

인증/권한 오류의 `code`는 아래 값으로 제한한다.

| HTTP | `code` | 의미 |
|---|---|---|
| 401 | `TOKEN_EXPIRED` | access token 만료. refresh를 한 번 시도할 수 있음 |
| 401 | `TOKEN_INVALID` | 위조/형식/서명/audience 오류. 즉시 로그인 화면으로 이동 |
| 401 | `INVALID_CREDENTIALS` | 사용자명 또는 비밀번호 불일치 |
| 401 | `REFRESH_TOKEN_INVALID` | refresh session 없음/만료/폐기 |
| 401 | `REFRESH_TOKEN_REUSED` | 이미 회전된 refresh token 재사용 탐지, token family 전체 폐기 |
| 403 | `PERMISSION_DENIED` | 인증은 성공했으나 필요한 권한 없음 |

## 4. 인증 API 상세

### 4.1 로그인

**API 이름:** 로그인  
**Method/Path:** `POST /api/v1/auth/login`  
**기능:** 사용자 자격 증명을 검증하고 짧은 수명의 access token 및 사용자/권한을 반환한다.
refresh token은 응답 JSON이 아니라 쿠키로만 설정한다.

#### Request

```http
Content-Type: application/json
```

```json
{
  "username": "noc.operator",
  "password": "user-entered-secret"
}
```

- `username`: trim 후 1~100자.
- `password`: 1~256자. 서버 로그, 오류 detail, 분석 이벤트에 기록하지 않는다.

#### Response `200`

```http
Set-Cookie: rack3d_refresh=<opaque-token>; Path=/api/v1/auth; HttpOnly; Secure; SameSite=Lax; Max-Age=2592000
Cache-Control: no-store
```

```json
{
  "data": {
    "accessToken": "eyJhbGciOi...",
    "tokenType": "Bearer",
    "expiresInSeconds": 900,
    "user": {
      "id": "user-42",
      "username": "noc.operator",
      "displayName": "NOC 운영자",
      "roles": ["nocOperator"],
      "permissions": ["dataCenter:read", "server:read", "incident:read", "incident:write"]
    }
  },
  "meta": {
    "requestId": "req_login_01",
    "generatedAt": "2026-07-28T02:14:05Z"
  }
}
```

#### 상태 코드와 검증

- `200`: 성공, refresh session 생성.
- `400`: JSON/필드 형식 오류.
- `401 INVALID_CREDENTIALS`: 사용자 존재 여부와 무관하게 같은 title/detail/응답 시간대를 사용한다.
- `429`: 계정 또는 IP 로그인 실패 제한 초과, `Retry-After` 포함.
- 성공/실패 응답 모두 `Cache-Control: no-store`.

### 4.2 access token 재발급

**API 이름:** access token 재발급  
**Method/Path:** `POST /api/v1/auth/refresh`  
**기능:** HttpOnly refresh cookie를 검증하고 access token을 재발급하며 refresh token을 회전한다.

#### Request

- Body 없음.
- 브라우저는 `credentials: "include"`로 `rack3d_refresh` 쿠키를 전송한다.
- access token은 필요하지 않다.

#### Response `200`

로그인과 같은 `data`를 반환한다. 새 refresh token으로 쿠키를 덮어쓰며, 이전 refresh token은
즉시 폐기한다.

```http
Set-Cookie: rack3d_refresh=<new-opaque-token>; Path=/api/v1/auth; HttpOnly; Secure; SameSite=Lax; Max-Age=2592000
Cache-Control: no-store
```

#### 상태 코드와 검증

- `200`: access token 재발급과 refresh rotation 성공.
- `401 REFRESH_TOKEN_INVALID`: 쿠키 없음, 만료, 폐기 또는 검증 실패.
- `401 REFRESH_TOKEN_REUSED`: 회전된 이전 token 재사용. 같은 token family의 모든 refresh
  session을 폐기하고 보안 이벤트를 남긴다.
- `429`: refresh 남용 제한.
- refresh 원문은 DB에 저장하지 않고 hash와 session/family ID, 만료/회전/폐기 시각을 저장한다.

### 4.3 로그아웃

**API 이름:** 로그아웃  
**Method/Path:** `POST /api/v1/auth/logout`  
**기능:** 현재 refresh session을 폐기하고 refresh cookie를 삭제한다.

#### Request

- `Authorization: Bearer <access-token>` 필수.
- `rack3d_refresh` 쿠키를 보내기 위해 `credentials: "include"` 사용.
- Body 없음.

#### Response `204`

```http
Set-Cookie: rack3d_refresh=; Path=/api/v1/auth; HttpOnly; Secure; SameSite=Lax; Max-Age=0
Cache-Control: no-store
```

Body는 없다. 이미 폐기된 session도 같은 사용자/session 문맥이면 idempotent하게 `204`를 반환한다.
access token은 짧은 수명 때문에 별도 blacklist 없이 클라이언트 메모리에서 즉시 삭제해도 된다.

### 4.4 현재 사용자 조회

**API 이름:** 현재 사용자 조회  
**Method/Path:** `GET /api/v1/auth/me`  
**기능:** 현재 access token의 사용자와 서버가 계산한 최신 역할/권한을 확인한다.

#### Request

`Authorization: Bearer <access-token>` 필수.

#### Response `200`

응답 헤더는 `Cache-Control: no-store`이며 `ETag`는 반환하지 않는다.

```json
{
  "data": {
    "id": "user-42",
    "username": "noc.operator",
    "displayName": "NOC 운영자",
    "roles": ["nocOperator"],
    "permissions": ["dataCenter:read", "server:read", "incident:read", "incident:write"]
  },
  "meta": {
    "requestId": "req_me_01",
    "generatedAt": "2026-07-28T02:14:05Z"
  }
}
```

- `401 TOKEN_EXPIRED` 또는 `401 TOKEN_INVALID`.
- 비활성화된 사용자/session은 `401 TOKEN_INVALID`.
- `Cache-Control: no-store`.

## 5. 데이터 API 상세

### 5.1 전산실 목록 조회

**API 이름:** 전산실 목록 조회  
**Method/Path:** `GET /data-centers`  
**기능:** 사용자가 접근 가능한 전산실 카드 목록과 요약 상태를 조회한다.

#### Request

| 위치 | 이름 | 필수 | 형식 | 설명 |
|---|---|---:|---|---|
| Query | `page` | N | integer | 기본 1 |
| Query | `pageSize` | N | integer | 기본 20, 최대 100 |
| Query | `status` | N | `operational`, `attention` | 상태 필터 |
| Query | `q` | N | string | 코드/이름/위치 부분 검색, trim 후 2~100자 |
| Header | `Authorization` | Y | Bearer token | `rack3d:read` |
| Header | `If-None-Match` | N | ETag | 조건부 조회 |

#### Response `200`

```json
{
  "data": [
    {
      "id": "seoul-main",
      "code": "SEL-01",
      "name": "서울 메인 전산실",
      "location": "서울특별시 강남구",
      "description": "핵심 서비스와 데이터베이스 인프라를 운영합니다.",
      "status": "attention",
      "rackCount": 4,
      "serverCount": 10,
      "activeIncidentCount": 3,
      "averageAmbientTemperatureCelsius": 21.4,
      "telemetryCollectedAt": "2026-07-28T02:14:00Z",
      "telemetryStale": false
    }
  ],
  "meta": {
    "requestId": "req_dc_list_01",
    "generatedAt": "2026-07-28T02:14:05Z",
    "page": 1,
    "pageSize": 20,
    "totalItems": 1,
    "totalPages": 1
  }
}
```

#### 상태 코드와 검증

- `200`: 성공, `304`: 변경 없음.
- `400`: pagination/status/q 형식 오류.
- 수치 count는 0 이상의 정수다.
- 평균 환경 온도를 알 수 없으면 `averageAmbientTemperatureCelsius: null`,
  `telemetryCollectedAt: null`, `telemetryStale: true`로 반환한다.
- 기본 정렬은 `code ASC`.

### 5.2 전산실 3D scene 조회

**API 이름:** 전산실 3D scene 조회  
**Method/Path:** `GET /data-centers/{dataCenterId}/scene`  
**기능:** 3D 렌더링에 필요한 grid, 랙 배치, 서버 장착 위치와 경량 상태를 한 번에 조회한다.

#### Request

| 위치 | 이름 | 필수 | 형식 | 설명 |
|---|---|---:|---|---|
| Path | `dataCenterId` | Y | string | 전산실 ID |
| Header | `Authorization` | Y | Bearer token | `rack3d:read` |
| Header | `If-None-Match` | N | ETag | inventory 조건부 조회 |

Body는 없다.

#### Response `200`

아래 예시는 문서 가독성을 위해 `racks` 4개 중 A-02 한 개만 표시한 **축약 예시**다.
실제 wire 응답은 축약되지 않으며 `rackCount`와 같은 개수의 랙을 모두 포함한다.

```json
{
  "data": {
    "dataCenter": {
      "id": "seoul-main",
      "code": "SEL-01",
      "name": "서울 메인 전산실"
    },
    "rackCount": 4,
    "sceneVersion": 17,
    "inventoryCollectedAt": "2026-07-28T02:13:40Z",
    "inventoryStale": false,
    "grid": {
      "columns": 12,
      "rows": 14,
      "tileSizeMeters": 0.6
    },
    "racks": [
      {
        "id": "rack-a02",
        "label": "A-02",
        "totalUnits": 42,
        "gridX": 7,
        "gridZ": 4,
        "rotationDegrees": 0,
        "summary": {
          "serverCount": 3,
          "usedUnits": 4,
          "availableUnits": 38,
          "occupancyPercent": 9.5,
          "activeIncidentCount": 1,
          "statusCounts": {
            "healthy": 2,
            "warning": 0,
            "critical": 1,
            "offline": 0
          }
        },
        "servers": [
          {
            "id": "srv-004",
            "name": "Web 01",
            "modelCode": "hpe-proliant-dl360-gen11",
            "startU": 1,
            "units": 1,
            "status": "healthy"
          },
          {
            "id": "srv-005",
            "name": "Web 02",
            "modelCode": "hpe-proliant-dl360-gen11",
            "startU": 3,
            "units": 1,
            "status": "critical"
          },
          {
            "id": "srv-006",
            "name": "Compute 01",
            "modelCode": "dell-poweredge-r760",
            "startU": 8,
            "units": 2,
            "status": "healthy"
          }
        ]
      }
    ]
  },
  "meta": {
    "requestId": "req_scene_01",
    "generatedAt": "2026-07-28T02:14:05Z"
  }
}
```

#### 상태 코드와 검증

- `200`: 성공, `304`: 변경 없음, `404`: 전산실 없음/권한 없음.
- `racks`는 pagination 없는 해당 전산실의 **전체 랙 목록**이다. 실제 응답에서
  `rackCount == racks.length`이며 `GET /data-centers`의 같은 전산실 `rackCount`와도 일치해야 한다.
- `gridX`, `gridZ`는 0 이상의 정수이며 grid 범위 안이어야 한다.
- 한 전산실에서 랙 셀 위치가 겹치면 안 된다.
- `totalUnits`는 1~60, `startU`는 1 이상, `units`는 MVP에서 `1` 또는 `2`.
- `startU + units - 1 <= totalUnits`여야 한다.
- 같은 랙의 서버 U 범위는 겹치면 안 된다.
- `modelCode`는 현재 제공되는 세 GLB 키 중 하나여야 한다.
- 각 랙의 `servers`는 부분 목록이 아니라 해당 랙에 설치된 **전체 서버 목록**이다.
  `summary.serverCount == servers.length`이고 `summary.statusCounts`는 이 배열의 상태별 개수와
  정확히 일치해야 한다.
- `summary.usedUnits`는 중복 없는 점유 U 수이며 서버 `units` 합과 일치해야 한다.
- rack 기본 정렬은 `label ASC`, server 기본 정렬은 `startU DESC`.

### 5.3 전산실 대시보드 조회

**API 이름:** 전산실 대시보드 조회  
**Method/Path:** `GET /data-centers/{dataCenterId}/dashboard`  
**기능:** 대시보드 KPI/차트와 3D 히트맵에 필요한 계산 완료 집계를 조회한다.

#### Request

| 위치 | 이름 | 필수 | 형식 | 설명 |
|---|---|---:|---|---|
| Path | `dataCenterId` | Y | string | 전산실 ID |
| Query | `historyHours` | N | integer | 기본/최대 24, MVP는 24만 허용 |
| Header | `Authorization` | Y | Bearer token | `rack3d:read` |
| Header | `If-None-Match` | N | ETag | 조건부 조회 |

#### Response `200`

```json
{
  "data": {
    "dataCenterId": "seoul-main",
    "snapshotAt": "2026-07-28T02:14:00Z",
    "capacity": {
      "totalUnits": 42,
      "usedUnits": 4,
      "availableUnits": 38,
      "occupancyPercent": 9.5
    },
    "servers": {
      "totalCount": 3,
      "healthyPercent": 66.7,
      "statusCounts": {
        "healthy": 2,
        "warning": 0,
        "critical": 1,
        "offline": 0
      },
      "modelCounts": {
        "dell-poweredge-r760": 1,
        "hpe-proliant-dl360-gen11": 2,
        "cisco-ucs-c240-m7": 0
      }
    },
    "activeIncidentCount": 1,
    "temperatureHistory": [
      {
        "bucketAt": "2026-07-28T01:00:00Z",
        "roomAverageCelsius": 21.2,
        "rackCelsius": {
          "rack-a02": 21.2
        },
        "sampleCount": 1
      }
    ],
    "rackMetrics": [
      {
        "rackId": "rack-a02",
        "rackLabel": "A-02",
        "serverCount": 3,
        "usedUnits": 4,
        "availableUnits": 38,
        "largestFreeBlockUnits": 34,
        "occupancyPercent": 9.5,
        "activeIncidentCount": 1,
        "maxServerTemperatureCelsius": 72.0,
        "powerWatts": 852.0,
        "networkMbps": 2608.0,
        "incidentDensityPercent": 33.3,
        "telemetrySampleCount": 3,
        "telemetryCollectedAt": "2026-07-28T02:14:00Z",
        "telemetryStale": false
      }
    ]
  },
  "meta": {
    "requestId": "req_dashboard_01",
    "generatedAt": "2026-07-28T02:14:05Z"
  }
}
```

#### 집계와 검증

- `usedUnits`: 각 랙에서 장비가 점유한 중복 없는 U의 합.
- `availableUnits = totalUnits - usedUnits`.
- `occupancyPercent = usedUnits / totalUnits * 100`. 분모가 0이면 `null`.
- `healthyPercent = healthy / totalCount * 100`. 분모가 0이면 `null`.
- `maxServerTemperatureCelsius`: offline 서버와 `null` 표본을 제외한 최댓값.
- `powerWatts`, `networkMbps`: 수집 가능한 최신 서버 표본의 합. 표본 0이면 `null`.
- `telemetryCollectedAt`: 집계에 사용한 표본 중 가장 오래된 수집 시각이다.
- `temperatureHistory`는 UTC 정시 1시간 bucket, 오래된 순으로 최대 24개다.
  센서 값이 하나도 없으면 해당 bucket 값은 `null`, `sampleCount`는 0이다.
- `rackMetrics[].rackId` 집합과 각 `temperatureHistory[].rackCelsius`의 key 집합은 같은
  snapshot의 scene `racks[].id` 집합과 정확히 일치해야 한다. 센서가 미수집된 랙도 key를
  생략하지 않고 값을 `null`로 반환한다.
- percent는 원본 계산 후 소수점 첫째 자리 반올림을 권장한다.
- `incidentDensityPercent` 공식은 7장을 따른다.

#### 상태 코드

- `200`, `304`, `400`(`historyHours` 오류), `404`, 공통 오류.

### 5.4 전산실 장애 목록 조회

**API 이름:** 전산실 장애 목록 조회  
**Method/Path:** `GET /data-centers/{dataCenterId}/incidents`  
**기능:** 장애 네비게이터와 표에 표시할 장애 목록을 조회한다.

#### Request

| 위치 | 이름 | 필수 | 형식 | 설명 |
|---|---|---:|---|---|
| Path | `dataCenterId` | Y | string | 전산실 ID |
| Query | `status` | N | CSV | `open,acknowledged,resolved`; 기본 `open,acknowledged` |
| Query | `severity` | N | CSV | `warning,offline,critical` |
| Query | `rackId` | N | string | 랙 필터 |
| Query | `page` | N | integer | 기본 1 |
| Query | `pageSize` | N | integer | 기본 20, 최대 100 |
| Header | `Authorization` | Y | Bearer token | `rack3d:read` |
| Header | `If-None-Match` | N | ETag | 조건부 조회 |

#### Response `200`

아래 `data`는 형식을 보여 주기 위해 1건만 적은 축약 예시다. 실제 응답은 현재 page의
`pageSize` 이하 항목을 모두 포함하며 `meta.totalItems`는 전체 필터 결과 수다.

```json
{
  "data": [
    {
      "id": "inc-20260728-005",
      "dataCenter": { "id": "seoul-main", "code": "SEL-01", "name": "서울 메인 전산실" },
      "rack": { "id": "rack-a02", "label": "A-02" },
      "server": { "id": "srv-005", "name": "Web 02", "status": "critical" },
      "type": "serverFault",
      "severity": "critical",
      "status": "open",
      "detectedAt": "2026-07-28T01:56:00Z",
      "durationSeconds": 1085,
      "acknowledgedAt": null,
      "assignee": null,
      "summary": "CPU 온도 임계치 초과",
      "version": 3,
      "updatedAt": "2026-07-28T02:12:00Z"
    }
  ],
  "meta": {
    "requestId": "req_incidents_01",
    "generatedAt": "2026-07-28T02:14:05Z",
    "page": 1,
    "pageSize": 20,
    "totalItems": 3,
    "totalPages": 1
  }
}
```

#### 상태 코드와 검증

- `200`, `304`, `400`, `404`, 공통 오류.
- 기본 정렬: `critical` → `offline` → `warning`, 같은 심각도는 `detectedAt DESC`.
- 활성 장애의 `durationSeconds = generatedAt - detectedAt`.
- `acknowledged` 상태이면 `acknowledgedAt`이 필수다.
- `resolved`는 기본 목록에서 제외된다.
- 동일 원천 이벤트를 polling 중 중복 장애 ID로 생성하면 안 된다.

### 5.5 서버 상세 조회

**API 이름:** 서버 상세 조회  
**Method/Path:** `GET /servers/{serverId}`  
**기능:** 선택한 서버의 자산 정보, 최신 telemetry, 최근 활동, 활성 장애 참조를 조회한다.

#### Request

| 위치 | 이름 | 필수 | 형식 | 설명 |
|---|---|---:|---|---|
| Path | `serverId` | Y | string | 서버 ID |
| Query | `activityLimit` | N | integer | 기본 10, 최소 0, 최대 50 |
| Header | `Authorization` | Y | Bearer token | `rack3d:read` |
| Header | `If-None-Match` | N | ETag | 조건부 조회 |

#### Response `200`

```json
{
  "data": {
    "id": "srv-005",
    "name": "Web 02",
    "role": "Web Frontend",
    "modelCode": "hpe-proliant-dl360-gen11",
    "modelName": "HPE ProLiant DL360 Gen11",
    "serialNumber": "HPE-SN-4F82P2",
    "ipAddress": "10.24.12.42",
    "operatingSystem": "Ubuntu Server 22.04 LTS",
    "status": "critical",
    "dataCenter": { "id": "seoul-main", "code": "SEL-01", "name": "서울 메인 전산실" },
    "rack": { "id": "rack-a02", "label": "A-02", "startU": 3, "units": 1 },
    "telemetry": {
      "cpuPercent": 96.0,
      "memoryPercent": 88.0,
      "storagePercent": 72.0,
      "temperatureCelsius": 72.0,
      "powerWatts": 238.0,
      "networkMbps": 1260.0,
      "uptimeSeconds": 8040,
      "collectedAt": "2026-07-28T02:14:01Z",
      "dataAgeSeconds": 4,
      "stale": false
    },
    "activities": [
      {
        "id": "act-1024",
        "occurredAt": "2026-07-28T02:14:00Z",
        "message": "CPU temperature exceeded threshold",
        "tone": "critical"
      }
    ],
    "activeIncidentIds": ["inc-20260728-005"],
    "updatedAt": "2026-07-28T02:14:01Z"
  },
  "meta": {
    "requestId": "req_server_01",
    "generatedAt": "2026-07-28T02:14:05Z"
  }
}
```

#### 상태 코드와 검증

- `200`, `304`, `400`(`activityLimit`), `404`, 공통 오류.
- percent 값은 수집된 경우 0~100.
- IP는 IPv4 또는 IPv6 문자열이며, 사용자가 접근 권한이 없으면 정책에 따라 마스킹할 수 있다.
- `activities`는 `occurredAt DESC`.
- offline/수집 불가 시 개별 telemetry 값은 `null`; 마지막 성공 시각을 유지할 수 있으나
  `stale: true`여야 한다. 한 번도 성공하지 못했다면 `collectedAt`과 `dataAgeSeconds`도 `null`.

### 5.6 전산실 자산 검색

**API 이름:** 전산실 자산 검색  
**Method/Path:** `GET /data-centers/{dataCenterId}/assets/search`  
**기능:** 서버명, IP, 시리얼, 랙 ID/라벨을 검색해 해당 랙/서버로 이동할 수 있는 결과를 반환한다.

#### Request

| 위치 | 이름 | 필수 | 형식 | 설명 |
|---|---|---:|---|---|
| Path | `dataCenterId` | Y | string | 전산실 ID |
| Query | `q` | Y | string | trim 후 2~100자 |
| Query | `types` | N | CSV | `rack,server`; 기본 모두 |
| Query | `limit` | N | integer | 기본 10, 최소 1, 최대 50 |
| Header | `Authorization` | Y | Bearer token | `rack3d:read` |

#### Response `200`

응답 헤더는 `Cache-Control: no-store`이며 `ETag`는 반환하지 않는다.

```json
{
  "data": [
    {
      "assetType": "server",
      "id": "srv-005",
      "name": "Web 02",
      "subtitle": "10.24.12.42 · HPE-SN-4F82P2",
      "status": "critical",
      "rack": { "id": "rack-a02", "label": "A-02" },
      "matchedFields": ["name", "ipAddress"]
    },
    {
      "assetType": "rack",
      "id": "rack-a02",
      "name": "A-02",
      "subtitle": "3 servers · 1 active incident",
      "status": "attention",
      "rack": { "id": "rack-a02", "label": "A-02" },
      "matchedFields": ["label"]
    }
  ],
  "meta": {
    "requestId": "req_search_01",
    "generatedAt": "2026-07-28T02:14:05Z",
    "limit": 10,
    "returnedItems": 2
  }
}
```

#### 상태 코드와 검증

- `200`은 결과가 없어도 빈 배열로 반환한다. `400`: q/types/limit 오류, `404`: 전산실 없음.
- 검색은 대소문자를 구분하지 않는 부분 일치를 최소 지원한다.
- 정렬 우선순위: exact ID/serial/IP → 이름/label prefix → 부분 일치 → `name ASC`.
- `matchedFields` 값은 `id`, `name`, `label`, `ipAddress`, `serialNumber` 중 하나다.
- 서버 상태는 `ServerStatus`, 랙 상태는 `operational` 또는 `attention`이다.
- IP/시리얼 검색과 응답은 `rack3d:read` 및 해당 전산실 권한이 있는 사용자에게만 허용한다.

### 5.7 장애 상세 조회

**API 이름:** 장애 상세 조회  
**Method/Path:** `GET /incidents/{incidentId}`  
**기능:** 장애 처리에 필요한 원천 정보, 확인/담당자/메모, 감사 필드를 조회한다.

#### Request

| 위치 | 이름 | 필수 | 형식 | 설명 |
|---|---|---:|---|---|
| Path | `incidentId` | Y | string | 장애 ID |
| Header | `Authorization` | Y | Bearer token | `rack3d:read` |
| Header | `If-None-Match` | N | ETag | 조건부 조회 |

#### Response `200`

응답 헤더: `ETag: "incident-inc-20260728-005-v3"`

```json
{
  "data": {
    "id": "inc-20260728-005",
    "source": {
      "system": "prometheus-alertmanager",
      "eventId": "evt-8de12"
    },
    "dataCenter": { "id": "seoul-main", "code": "SEL-01", "name": "서울 메인 전산실" },
    "rack": { "id": "rack-a02", "label": "A-02" },
    "server": { "id": "srv-005", "name": "Web 02", "status": "critical" },
    "type": "serverFault",
    "severity": "critical",
    "status": "open",
    "summary": "CPU 온도 임계치 초과",
    "description": "5분 평균 CPU 온도가 85°C 기준을 초과했습니다.",
    "detectedAt": "2026-07-28T01:56:00Z",
    "durationSeconds": 1085,
    "acknowledgedAt": null,
    "acknowledgedBy": null,
    "assignee": null,
    "note": "애플리케이션 상태 점검이 필요합니다.",
    "resolvedAt": null,
    "version": 3,
    "createdAt": "2026-07-28T01:56:02Z",
    "updatedAt": "2026-07-28T02:12:00Z"
  },
  "meta": {
    "requestId": "req_incident_01",
    "generatedAt": "2026-07-28T02:14:05Z"
  }
}
```

#### 상태 코드와 검증

- `200`, `304`, `404`, 공통 오류.
- `source.system + source.eventId`는 중복 수집 방지용으로 유일해야 한다.
- `resolved`이면 `resolvedAt`이 필수다.
- `version`은 변경될 때마다 1 증가한다.

### 5.8 장애 처리 정보 수정

**API 이름:** 장애 처리 정보 수정  
**Method/Path:** `PATCH /incidents/{incidentId}`  
**기능:** 장애 확인 상태, 담당자, 운영 메모를 수정한다. 장애 종료는 지원하지 않는다.

#### Request

| 위치 | 이름 | 필수 | 형식 | 설명 |
|---|---|---:|---|---|
| Path | `incidentId` | Y | string | 장애 ID |
| Header | `Authorization` | Y | Bearer token | `rack3d:incident:write` |
| Header | `Content-Type` | Y | `application/merge-patch+json` | |
| Header | `If-Match` | Y | ETag | 마지막 상세 조회 ETag |
| Body | `status` | N | `open`, `acknowledged` | `resolved` 금지 |
| Body | `assignee` | N | string 또는 null | trim 후 최대 100자 |
| Body | `note` | N | string | 최대 4000자 |

최소 한 필드는 있어야 한다.

```json
{
  "status": "acknowledged",
  "assignee": "NOC L1",
  "note": "관리 네트워크와 전원 피드를 확인 중입니다."
}
```

#### Response `200`

응답 헤더: `ETag: "incident-inc-20260728-005-v4"`

```json
{
  "data": {
    "id": "inc-20260728-005",
    "source": {
      "system": "prometheus-alertmanager",
      "eventId": "evt-8de12"
    },
    "dataCenter": { "id": "seoul-main", "code": "SEL-01", "name": "서울 메인 전산실" },
    "rack": { "id": "rack-a02", "label": "A-02" },
    "server": { "id": "srv-005", "name": "Web 02", "status": "critical" },
    "type": "serverFault",
    "severity": "critical",
    "status": "acknowledged",
    "summary": "CPU 온도 임계치 초과",
    "description": "5분 평균 CPU 온도가 85°C 기준을 초과했습니다.",
    "detectedAt": "2026-07-28T01:56:00Z",
    "durationSeconds": 1100,
    "acknowledgedAt": "2026-07-28T02:14:20Z",
    "acknowledgedBy": "user-42",
    "assignee": "NOC L1",
    "note": "관리 네트워크와 전원 피드를 확인 중입니다.",
    "resolvedAt": null,
    "version": 4,
    "createdAt": "2026-07-28T01:56:02Z",
    "updatedAt": "2026-07-28T02:14:20Z"
  },
  "meta": {
    "requestId": "req_incident_patch_01",
    "generatedAt": "2026-07-28T02:14:20Z"
  }
}
```

#### 상태 코드와 검증

- `200`: 수정된 전체 장애 객체 반환.
- `400`: 빈 body, 미지원 필드, 형식/길이 오류.
- `403`: 쓰기 scope 없음.
- `404`: 장애 없음/권한 없음.
- `409`: 이미 원천 시스템에서 `resolved`된 장애를 수정하려 함.
- `412`: `If-Match`와 현재 ETag 불일치.
- `415`: Content-Type 오류.
- `428`: `If-Match` 누락.
- `status: acknowledged` 전환 시 서버가 `acknowledgedAt`, `acknowledgedBy`를 기록한다.
- `status: open`으로 재오픈하면 두 필드를 `null`로 되돌린다.
- 요청 body에 `resolved`, `resolvedAt`, `severity`, `server`, `source`, `version` 등
  서버 관리 필드를 보내면 `400`으로 거절한다.
- 메모/담당자/상태 변경은 사용자, 시각, 이전/새 값과 `requestId`를 감사 로그에 남긴다.

## 6. 데이터 enum과 필드 사전

### 6.1 Enum

| 이름 | 값 | 의미 |
|---|---|---|
| `DataCenterStatus` | `operational`, `attention` | 정상 / 확인이 필요한 상태 |
| `ServerStatus` | `healthy`, `warning`, `critical`, `offline` | 정상 / 경고 / 심각 / 연결 또는 전원 단절 |
| `ServerModelCode` | `dell-poweredge-r760`, `hpe-proliant-dl360-gen11`, `cisco-ucs-c240-m7` | 현재 프런트에 존재하는 GLB 파일 키 |
| `IncidentSeverity` | `warning`, `offline`, `critical` | 서버 상태와 같은 장애 심각도 |
| `IncidentStatus` | `open`, `acknowledged`, `resolved` | 신규/미확인, 운영자 확인, 원천 시스템 해소 |
| `IncidentType` | `healthWarning`, `serverFault`, `connectionLost` | 건강 경고, 서버 결함, 연결 단절 |
| `ActivityTone` | `normal`, `warning`, `critical` | 활동 메시지 표시 색상 |
| `AssetType` | `rack`, `server` | 검색 결과 자산 종류 |

### 6.2 핵심 필드

| 필드 | 형식/단위 | nullable | 설명 |
|---|---|---:|---|
| `gridX`, `gridZ` | integer | N | scene grid 셀 좌표 |
| `rotationDegrees` | number/degree | N | Y축 회전, `[0, 360)` |
| `totalUnits` | integer/U | N | 랙 전체 높이 |
| `startU` | integer/U | N | 서버가 시작하는 가장 낮은 U, 1-based |
| `units` | integer/U | N | 서버가 점유하는 높이 |
| `usedUnits` | integer/U | N | 중복 없는 점유 U |
| `largestFreeBlockUnits` | integer/U | N | 랙의 가장 긴 연속 빈 U |
| `averageAmbientTemperatureCelsius` | number/°C | Y | 전산실 환경 센서 평균 |
| `temperatureCelsius` | number/°C | Y | 서버 내부/흡입구 등 서버 telemetry 온도 |
| `powerWatts` | number/W | Y | 현재 소비 전력 |
| `networkMbps` | number/Mbps | Y | 송수신 합산 처리량 |
| `uptimeSeconds` | integer/sec | Y | 현재 연속 가동 시간 |
| `dataAgeSeconds` | integer/sec | Y | 응답 생성 시각 대비 데이터 나이 |
| `sceneVersion`, `version` | integer | N | 각각 inventory와 incident의 단조 증가 버전 |

## 7. 히트맵 계산 의미

백엔드는 `rackMetrics`에 원시 집계값을 제공하고, 프런트는 같은 전산실 랙끼리 정규화해 색상을 만든다.

| 모드 | API 필드 | 계산 |
|---|---|---|
| Temperature | `maxServerTemperatureCelsius` | offline/null 제외 서버 온도의 최대 |
| Power draw | `powerWatts` | null 제외 서버 전력 합 |
| Network traffic | `networkMbps` | null 제외 서버 송수신 처리량 합 |
| U occupancy | `occupancyPercent` | `usedUnits / totalUnits * 100` |
| Incident density | `incidentDensityPercent` | 아래 가중치 공식 |

장애 밀도 공식:

```text
weighted = warningCount * 1 + offlineCount * 2 + criticalCount * 3
incidentDensityPercent = weighted / (serverCount * 3) * 100
```

- `healthy` 가중치는 0이다.
- `serverCount == 0`이면 `incidentDensityPercent`는 `0.0`으로 반환한다.
- UI 색상 기준은 현 구현과 동일하게 low(파랑) → middle(노랑) → high(빨강)이다.
- MVP 프런트 정규화 권장 범위:
  - temperature: 30~80°C
  - power: 0~`max(1500, fleetMax * 1.1)` W
  - traffic: 0~`max(3000, fleetMax * 1.1)` Mbps
  - occupancy/incidents: 0~100%

## 8. Polling과 캐시 권장안

MVP는 polling으로 구현하고 SSE는 후속 버전에서 검토한다.

| API | 권장 호출 시점/주기 | 권장 Cache-Control |
|---|---|---|
| `/data-centers` | 목록 진입, 60초 | `private, max-age=30` |
| `.../scene` | 전산실 진입, 이후 60초 | `private, max-age=30, must-revalidate` |
| `.../dashboard` | 패널 open 즉시, open 동안 15초 | `private, no-cache` |
| `.../incidents` | scene에서 15초, 장애 모드에서 5초 | `private, no-cache` |
| `/servers/{id}` | 선택 즉시, 선택 중 10초 | `private, no-cache` |
| `.../assets/search` | 입력 250~300ms debounce, 2자 이상 | `no-store` |
| `/incidents/{id}` | 상세 open, PATCH 후 | `private, no-cache` |

- 프런트는 동일 요청의 중복 실행을 합치고 화면 전환 시 불필요한 요청을 취소한다.
- polling GET에는 `If-None-Match`를 보내 `304`를 활용한다. `/auth/me`와 검색은 예외다.
- 네트워크 오류는 1초부터 최대 30초까지 지수 backoff + jitter를 적용한다.
- 탭이 background이면 dashboard/server polling은 중지하거나 최소 60초로 늦춘다.
- PATCH 직후 incident detail/list/dashboard 캐시를 무효화한다.

## 9. 보안과 운영

- tenant/data center 단위로 서버 측 권한 검사를 수행한다. query/path 값만 신뢰하지 않는다.
- access token TTL은 10~15분, refresh session은 정책에 따라 최대 30일을 권장한다.
- refresh는 매 사용 시 rotation하며 재사용 탐지 시 token family 전체를 폐기하고 사용자에게
  재로그인을 요구한다.
- 로그인 실패는 계정과 IP를 함께 기준으로 제한한다. 권장 시작값은 15분 내 5회 실패 후
  지연/일시 잠금이며, `429`와 `Retry-After`를 사용한다. 성공 여부와 관계없이 감사 로그를 남긴다.
- 로그인 오류는 사용자 존재 여부를 노출하지 않으며 password/token/cookie 원문을 로그에 남기지 않는다.
- IP, 시리얼, 운영 메모는 운영 정보로 분류하고 응답/로그/분석 도구로 불필요하게 복제하지 않는다.
- 검색 query에 대한 SQL/검색엔진 escaping, 길이 제한, rate limit을 적용한다.
- 권장 rate limit: 일반 조회 사용자당 120 req/min, 검색 60 req/min, PATCH 30 req/min.
- 장애 PATCH는 CSRF보다 Bearer token 탈취 방지가 핵심이므로 짧은 access token과 TLS를 사용한다.
- 감사 로그는 변경자 subject, 변경 전/후, incident ID, 시각, request ID를 포함한다.
- API 로그에는 access token, 전체 IP/시리얼, 운영 메모 본문을 남기지 않는다.
- 응답에 `X-Content-Type-Options: nosniff`와 적절한 CORS allowlist를 적용한다.

## 10. 백엔드 구현 체크리스트

- [ ] login/refresh/logout/me와 access token 서명/검증
- [ ] HttpOnly/Secure/SameSite refresh cookie 및 rotation/reuse detection
- [ ] 계정/IP 로그인 실패 제한과 일반화된 `INVALID_CREDENTIALS` 오류
- [ ] `TOKEN_EXPIRED`, `TOKEN_INVALID`, `PERMISSION_DENIED` 오류 code 일관 적용
- [ ] `/api/rack3d/v1` routing과 Bearer 인증/scope 검증
- [ ] 접근 가능한 전산실 기준의 row-level authorization
- [ ] 자산 원천에서 data center/rack/server inventory 동기화
- [ ] `gridX`, `gridZ`, `rotationDegrees`, U 범위 및 중복 배치 검증
- [ ] modelCode를 현재 세 GLB 키로 매핑
- [ ] 모니터링 원천에서 서버/환경 telemetry 수집 및 단위 통일
- [ ] missing/offline 값을 0으로 대체하지 않고 null/freshness 저장
- [ ] rack/data center 집계 및 장애 밀도 공식 구현
- [ ] source event 기준 장애 upsert와 중복 방지
- [ ] 장애 `resolved`는 원천 시스템 이벤트만 허용
- [ ] PATCH ETag/If-Match/version과 감사 로그
- [ ] pagination/안정 정렬/검색 ranking
- [ ] GET ETag/304, Cache-Control, rate limit
- [ ] RFC 9457 공통 오류 middleware와 requestId 전파
- [ ] OpenAPI contract test 및 대표 example fixture
- [ ] 권한 밖 ID, stale telemetry, 빈 전산실, 0개 검색 결과 테스트
- [ ] scene 응답 gzip/brotli 적용 및 목표 응답 크기/지연 모니터링

## 11. 프런트 연동 순서

1. 공통 API client: API base 분리, Bearer token, cookie credentials, Problem Details,
   request cancellation, ETag cache.
2. access token은 JavaScript 메모리에만 저장한다. localStorage/sessionStorage 저장은 XSS 노출
   때문에 금지하는 것을 권장한다.
3. 앱 스플래시에서 `POST /api/v1/auth/refresh`를 먼저 호출하고, 성공하면 access token을
   메모리에 저장한 뒤 `GET /api/v1/auth/me`로 최신 사용자/권한을 확인한다.
4. refresh 실패 시 로그인 화면을 표시한다. 로그인 성공 후 `/me` 확인을 거쳐 전산실 목록으로 이동한다.
5. 보호 API가 `401 TOKEN_EXPIRED`를 반환하면 여러 동시 요청을 하나의 refresh promise로 합치고,
   refresh 성공 후 원 요청을 **한 번만** 재시도한다. 재시도도 401이면 토큰을 지우고 로그인 화면으로 간다.
6. `TOKEN_INVALID`, `REFRESH_TOKEN_INVALID`, `REFRESH_TOKEN_REUSED`는 자동 반복하지 않고 로그인한다.
7. `GET /data-centers`: 현재 `dataCenters` 상수 교체.
8. `GET .../scene`: `racks` 상수 교체, `rotationDegrees`를 radians로 변환.
9. `GET /servers/{id}`: `serverProfiles` 상수와 상대 시간 문자열 계산 교체.
10. `GET .../incidents`와 `GET /incidents/{id}`: `initialIncidentRecords` 및 장애 순회 교체.
11. `PATCH /incidents/{id}`: 확인/담당자/메모 저장, `412` 충돌 시 최신 상세 재조회.
12. `GET .../dashboard`: 로컬 `getDashboardMetrics`/데모 온도 history를 서버 집계로 교체.
13. `GET .../assets/search`: 로컬 search index를 debounce API 검색으로 교체.
14. polling/visibility/backoff와 loading/error/stale UI 추가.
15. mock fixture와 실제 API 응답을 OpenAPI contract test로 비교.

## 12. 후속 버전 후보

- SSE/WebSocket 기반 telemetry/incident delta
- 랙 배치와 서버 U 편집 API
- 임계치/장애 규칙 관리
- 과거 telemetry 기간/해상도 query
- assignee 사용자/팀 directory API
- 랙/서버 pagination이 필요한 대규모 scene의 chunk/LOD API

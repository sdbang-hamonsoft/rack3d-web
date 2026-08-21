# Rack3D API 간단 명세

## 1. 로그인

| 항목 | 내용 |
|---|---|
| API 이름/경로 | 로그인 — `/api/v1/auth/login` |
| Method | `POST` |
| 기능 설명 | 사용자 ID와 비밀번호를 확인하고 Access Token을 발급한다. Refresh Token은 HttpOnly 쿠키로 전달한다. |
| Request | `{ "username": "admin", "password": "password" }` |
| Response | `{ "accessToken": "eyJ...", "tokenType": "Bearer", "expiresInSeconds": 900, "user": { "id": "user-001", "name": "관리자", "roles": ["admin"] } }` |

## 2. Access Token 갱신

| 항목 | 내용 |
|---|---|
| API 이름/경로 | Access Token 갱신 — `/api/v1/auth/refresh` |
| Method | `POST` |
| 기능 설명 | 로그인 시 발급된 Refresh Token 쿠키를 사용해 새 Access Token을 발급한다. |
| Request | Body 없음. 브라우저가 Refresh Token 쿠키를 자동 전송한다. |
| Response | `{ "accessToken": "eyJ...", "tokenType": "Bearer", "expiresInSeconds": 900 }` |

## 3. 로그아웃

| 항목 | 내용 |
|---|---|
| API 이름/경로 | 로그아웃 — `/api/v1/auth/logout` |
| Method | `POST` |
| 기능 설명 | 현재 로그인 세션과 Refresh Token을 폐기한다. |
| Request | Header: `Authorization: Bearer {accessToken}` / Body 없음 |
| Response | Body 없음 (`204 No Content`) |

## 4. 현재 로그인 사용자 조회

| 항목 | 내용 |
|---|---|
| API 이름/경로 | 현재 사용자 조회 — `/api/v1/auth/me` |
| Method | `GET` |
| 기능 설명 | 현재 로그인한 사용자의 정보와 권한을 조회한다. |
| Request | Header: `Authorization: Bearer {accessToken}` |
| Response | `{ "id": "user-001", "username": "admin", "name": "관리자", "roles": ["admin"], "permissions": ["rack3d:read", "rack3d:incident:write"] }` |

## 5. 전산실 목록 조회

| 항목 | 내용 |
|---|---|
| API 이름/경로 | 전산실 목록 — `/api/v1/data-centers` |
| Method | `GET` |
| 기능 설명 | 전산실 선택 화면에 표시할 전산실 목록과 랙·서버·장애 수를 조회한다. |
| Request | Header: `Authorization: Bearer {accessToken}` / Query(선택): `status`, `page`, `pageSize` |
| Response | `{ "data": [{ "id": "seoul-main", "code": "SEL-01", "name": "서울 메인 전산실", "location": "서울특별시 강남구", "description": "핵심 인프라 운영", "status": "attention", "rackCount": 4, "serverCount": 10, "activeIncidentCount": 3, "averageInletTemperatureCelsius": 21.4 }], "summary": { "dataCenterCount": 3, "rackCount": 13, "serverCount": 43, "activeIncidentCount": 3 } }` |

## 6. 전산실 3D Scene 조회

| 항목 | 내용 |
|---|---|
| API 이름/경로 | 3D Scene — `/api/v1/data-centers/{dataCenterId}/scene` |
| Method | `GET` |
| 기능 설명 | 선택한 전산실의 전체 랙 위치와 각 랙에 설치된 전체 서버 정보를 조회한다. |
| Request | Header: `Authorization: Bearer {accessToken}` / Path: `dataCenterId` |
| Response | `{ "dataCenter": { "id": "seoul-main", "name": "서울 메인 전산실" }, "layout": { "gridCellSizeMeters": 0.6 }, "rackCount": 4, "racks": [{ "id": "rack-a02", "label": "A-02", "totalUnits": 42, "layout": { "gridX": 7, "gridZ": 4, "rotationDegrees": 0 }, "status": "critical", "servers": [{ "id": "srv-005", "name": "Web 02", "modelCode": "hpe-proliant-dl360-gen11", "startUnit": 3, "unitHeight": 1, "status": "critical" }] }] }` |

## 7. 전산실 대시보드 조회

| 항목 | 내용 |
|---|---|
| API 이름/경로 | 전산실 대시보드 — `/api/v1/data-centers/{dataCenterId}/dashboard` |
| Method | `GET` |
| 기능 설명 | 서버 상태, 랙 사용량, 장비 모델 분포와 전산실·랙 온도 추이를 조회한다. |
| Request | Header: `Authorization: Bearer {accessToken}` / Path: `dataCenterId` / Query(선택): `from`, `to`, `interval` |
| Response | `{ "health": { "totalServers": 10, "healthyPercent": 70, "statusCounts": { "healthy": 7, "warning": 1, "critical": 1, "offline": 1 } }, "capacity": { "totalUnits": 168, "usedUnits": 15, "availableUnits": 153 }, "hardwareModels": [{ "modelCode": "hpe-proliant-dl360-gen11", "count": 5 }], "environmentTemperatureSeries": [{ "timestamp": "2026-07-28T02:00:00Z", "dataCenterAverageCelsius": 21.4 }] }` |

## 8. 전산실 장애 목록 조회

| 항목 | 내용 |
|---|---|
| API 이름/경로 | 장애 목록 — `/api/v1/data-centers/{dataCenterId}/incidents` |
| Method | `GET` |
| 기능 설명 | 선택한 전산실에서 발생한 장애 목록을 조회한다. |
| Request | Header: `Authorization: Bearer {accessToken}` / Path: `dataCenterId` / Query(선택): `status`, `severity`, `rackId`, `serverId`, `page`, `pageSize` |
| Response | `{ "data": [{ "id": "inc-001", "typeCode": "SERVER_FAULT", "severity": "critical", "status": "open", "assetState": "critical", "detectedAt": "2026-07-28T01:56:00Z", "durationSeconds": 1085, "server": { "id": "srv-005", "name": "Web 02" }, "rack": { "id": "rack-a02", "label": "A-02" } }] }` |

## 9. 서버 상세 조회

| 항목 | 내용 |
|---|---|
| API 이름/경로 | 서버 상세 — `/api/v1/servers/{serverId}` |
| Method | `GET` |
| 기능 설명 | 선택한 서버의 기본 정보, 설치 위치, 현재 상태, 텔레메트리와 최근 활동을 조회한다. |
| Request | Header: `Authorization: Bearer {accessToken}` / Path: `serverId` |
| Response | `{ "id": "srv-005", "name": "Web 02", "role": "Web Frontend", "status": "critical", "model": { "code": "hpe-proliant-dl360-gen11", "displayName": "HPE ProLiant DL360 Gen11" }, "serialNumber": "HPE-SN-4F82P2", "managementIpAddress": "10.24.12.42", "location": { "rackId": "rack-a02", "startUnit": 3, "unitHeight": 1 }, "telemetry": { "cpuUsagePercent": 96, "memoryUsagePercent": 88, "storageUsagePercent": 72, "serverTemperatureCelsius": 72, "powerWatts": 238, "networkMbps": 1260 } }` |

## 10. 자산 검색

| 항목 | 내용 |
|---|---|
| API 이름/경로 | 랙·서버 검색 — `/api/v1/data-centers/{dataCenterId}/assets/search` |
| Method | `GET` |
| 기능 설명 | 랙 이름, 서버명, IP, 시리얼 번호, 모델명 등으로 자산을 검색한다. |
| Request | Header: `Authorization: Bearer {accessToken}` / Path: `dataCenterId` / Query: `q` / Query(선택): `types`, `limit` |
| Response | `{ "data": [{ "kind": "server", "id": "srv-005", "label": "Web 02", "subtitle": "RACK A-02 · U03 · 10.24.12.42", "status": "critical", "rackId": "rack-a02", "startUnit": 3, "unitHeight": 1 }] }` |

## 11. 장애 상세 조회

| 항목 | 내용 |
|---|---|
| API 이름/경로 | 장애 상세 — `/api/v1/incidents/{incidentId}` |
| Method | `GET` |
| 기능 설명 | 선택한 장애의 상태, 발생 시각, 담당자, 조치 메모와 대상 서버 정보를 조회한다. |
| Request | Header: `Authorization: Bearer {accessToken}` / Path: `incidentId` |
| Response | `{ "id": "inc-001", "typeCode": "SERVER_FAULT", "severity": "critical", "status": "open", "detectedAt": "2026-07-28T01:56:00Z", "durationSeconds": 1085, "assignee": null, "operatorNote": "CPU 온도 임계치 초과", "server": { "id": "srv-005", "name": "Web 02" }, "version": 3 }` |

## 12. 장애 처리 정보 수정

| 항목 | 내용 |
|---|---|
| API 이름/경로 | 장애 수정 — `/api/v1/incidents/{incidentId}` |
| Method | `PATCH` |
| 기능 설명 | 장애 확인 상태, 담당자와 운영자 조치 메모를 수정한다. |
| Request | Header: `Authorization: Bearer {accessToken}`, `If-Match: "3"` / Path: `incidentId` / Body: `{ "status": "acknowledged", "assigneeId": "team-noc-l1", "operatorNote": "관리 네트워크를 확인 중입니다.", "version": 3 }` |
| Response | `{ "id": "inc-001", "status": "acknowledged", "assignee": { "id": "team-noc-l1", "displayName": "NOC L1" }, "operatorNote": "관리 네트워크를 확인 중입니다.", "version": 4 }` |

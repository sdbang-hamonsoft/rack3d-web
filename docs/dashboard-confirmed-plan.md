# rack3d 통합 대시보드 확정 시안 적용 기획 (v0.1 draft)

작성: planner / 2026-08-21 / 결정권자: sdbang / 상태: 🔵 기획 — 사용자 결정 대기

확정 시안: `/Volumes/ext-ssd/4.Test/fms/3D_dashboard.html` (533줄)

---

## 1. 요약

- 확정 시안은 **현재 rack3d 대시보드와 데이터 축이 다르다.** 현행은 "서버 자산 중심"(서버 상태 4분류·모델 3종·U 점유), 시안은 **"전산실 시설 환경 중심"**(랙별 전력/온도/습도, UPS·소방·항온항습기·누수·수배전반, 온습도 시계열, 담당자·조치상태가 붙은 장애 테이블)이다.
- 시안 표시 항목 **약 45개 중 현재 rack3d가 실제 데이터로 가진 것은 8개(U 점유 계열)뿐**이다. 나머지는 목업의 `Math.random()` 생성값이거나 하드코딩이다.
- **좋은 소식**: netis-fms에는 시설 계열 데이터가 이미 상당히 있다. 모니터링 유형 6종(`HVAC/DPM/UPS/TH/FIRE/LEAK`)과 지표 카탈로그가 V12에 시드되어 있어, 시안의 "주요 시설 운영 상태 요약 6종"은 거의 1:1로 대응된다.
- **나쁜 소식 2가지**:
  1. **netis-fms에는 IT 장비(서버/스위치) 단위 텔레메트리가 없다.** `assets.monitoring_type` CHECK 값은 `HVAC/DPM/UPS/TH/FIRE/LEAK/ACCESS/NVR`뿐이고 `metric_definitions`에 CPU·서버온도·트래픽 지표가 없다. 즉 현행 rack3d의 서버 상태·서버 온도·서버 전력·트래픽 히트맵은 FMS에서 채울 소스가 없다. rack3d가 이미 쓴 `docs/rack3d-api-spec.md` §5.3/§7이 이 소스를 전제하고 있어 **기존 결정과 정면 충돌**한다.
  2. **랙 단위 집계 API가 FMS에 없다.** 시안의 핵심인 "랙별 전력/온도/습도"는 데이터 모델상으로는 가능하지만(TH·DPM 센서 자산을 RACK 레이어 위치 노드에 매핑), 그렇게 배치·등록되어 있는지 확인되지 않았고 랙 단위로 묶는 조회 API도 없다.
- 제안 방향: **UI 교체(S1)를 먼저 하고 데이터는 나중에 붙인다.** 시안의 데이터 요구가 FMS E18(좌표)·신규 집계 API에 물려 있어, 데이터를 기다리면 UI가 몇 주 멈춘다.

---

## 2. 기존 스펙과의 관계 (충돌 여부)

| 기존 확정/작성물 | 관계 | 조치 제안 |
|---|---|---|
| `docs/rack3d-api-spec.md` §5.3 대시보드 조회 | **부분 충돌.** 응답에 습도·시설 설비·전력용량·PUE·장비 카테고리·랙별 전력/온습도가 전혀 없다. 있는 `rackMetrics[].powerWatts/networkMbps/maxServerTemperatureCelsius`는 서버 텔레메트리 합인데 FMS에 그 소스가 없다 | 시안 확정 시 §5.3 응답 스키마 개정 필요 |
| `docs/rack3d-api-spec.md` §7 히트맵 계산 | **충돌.** temperature/power/traffic 3모드가 서버 텔레메트리 기반 → FMS 소스 없음 | 히트맵을 랙 환경센서 기반으로 재정의하거나 3모드 비활성 |
| `docs/openapi/rack3d-v1.yaml` | 위와 동일 | §5.3 개정 시 동반 개정 |
| rack3d 전용 백엔드 vs netis-fms 직접 호출 | **구조적 미결.** rack3d API 명세는 "rack3d 전용 서버"를 전제하는데 실제 데이터 주인은 netis-fms다 | Q6에서 결정 필요 |
| netis-fms E19 예고 | **정합.** "rack3d가 E18 좌표 + E17 이미지를 가져간다"까지만 확정 | 본 기획은 E19 범위를 대시보드 데이터까지 확장해달라는 요청이 된다 |
| netis-fms E18 (layout-editor) | **미구현(🔵 기획 중).** `zone_layout_object` 테이블 없음(최신 V23 = `asset_image`) | rack3d 3D 배치는 당분간 localStorage 유지 |
| netis-fms E17 (자산 이미지·랙 U맵) | **구현됨.** `RackMapController` (`GET /api/zones/{id}/racks`, `GET /api/racks/{id}/u-map`) | 시안의 랙 점유율/장착 장비 목록은 이 API로 지금 바로 가능 |

---

## 3. 확정 시안 화면 구성 분해

시안은 **단일 페이지 전체화면 레이아웃**이다(`body { padding: 20px }` 위에 `.dashboard-container` 하나). 3D 씬 위에 얹는 패널 형태가 아니다 — Q1의 근거.

### A. 상단 네비 (153–180행)
| 표시 항목 | 필요 데이터 | 인터랙션 |
|---|---|---|
| 뒤로가기 버튼 | — | 이전 화면 복귀 |
| `BURUNET INFRASTRUCTURE` / 전산실명 / `SEL-01 · FULL MONITORING DASHBOARD` | 전산실 이름·코드 | — |
| 통합 검색창 | 랙 ID | `onkeyup` → 랙 그리드 필터. **주의: placeholder는 "Rack, 서버, 장애"인데 구현은 랙 ID 부분일치만**(418행) |
| `장애 시연 추가` 버튼 | — | 데모용. **실제 구현에서 제거 대상** |
| `TOTAL RACKS 36` / `DEVICES 342` | 랙 수, 장비 수 | — |
| `● LIVE` 배지 | 데이터 신선도 | 현행 rack3d 상단바에 이미 동일 UI 있음 |

### B. KPI 5카드 (186–212행)
| 카드 | 표시 값 | 부가 정보 |
|---|---|---|
| Rack Unit 점유 현황 | `682 / 1,512 U` | `점유율 45.1% (여유: 830U)` |
| 실시간 소비 전력 | `48.2 kW` | `용량 대비 40.1% (PUE: 1.25)` |
| 활성 장애 | `3` (빨강 카드) | `Critical 1 · Warning 2` |
| 전산실 평균 온도 | `22.4 °C` | `목표 범위: 20.0 ~ 24.0 °C` |
| 전산실 평균 습도 | `44.8 %` | `목표 범위: 40 ~ 55 %` |

### C. 상면 Rack 상태 그리드 (216–229, 377–419행)
- **범례 필터 5종**: 전체(36) / 포화(6, 빨강) / 여유(18, 초록) / 저사용(4, 주황) / 빈 Rack(8, 회색)
- **랙 카드 1장**: 랙명 + 상태 태그 / `40/42U (95%)` + 점유율 바 / 하단 메트릭 3종 ⚡전력 · 🌡온도(26°C 초과 시 빨강) · 💧습도 / 클릭 → 상세 모달
- **상태 4분류의 임계값이 목업에 정의돼 있지 않다.** 목업(348–351행)은 `idCounter % 5/4/3` 나머지로 상태를 먼저 정하고 점유율을 거기 맞춰 생성한다 → 점유율→상태 규칙이 존재하지 않음. Q7에서 정의 필요.

### D. 주요 시설 운영 상태 요약 6종 (231–259행)
| 카드 | 표시 값(목업) | 필요 데이터 |
|---|---|---|
| UPS 전력 부하 | `34.2 kW (42%)` | UPS 유효전력 합 + 부하율 |
| 소방 감지/방재 | `FM-200 정상` | 소화설비(가스계) 상태 |
| 항온항습기 #1 | `22.1°C / 45%` | HVAC 1호기 실내온·습도 |
| 항온항습기 #2 | `22.7°C / 44%` | HVAC 2호기 실내온·습도 |
| 누수 감지 케이블 | `정상 (미감지)` | 누수 접점 |
| 수배전반 상태 | `정상 (220V/380V)` | 배전반 전압·상태 |

**항온항습기가 2대로 고정 하드코딩**되어 있다 — 실제 N대 가변이므로 리스트 렌더로 재해석 필요.

### E. 장착 장비 구성 비율 도넛 (264–269, 459–477행)
Chart.js `doughnut`, 범례 우측. 5분류: x86 서버(180) / 고성능 GPU 서버(42) / L2·L3 스위치(50) / 스토리지 SAN·NAS(45) / 보안·방화벽(25) = 342대.

### F. 온습도 24시간 시계열 (270–275, 479–530행)
Chart.js `line`, **이중 Y축**(좌 온도 15~30, 우 습도 30~70, `drawOnChartArea:false`). 온도=빨강 실선+면적, 습도=파랑 점선. X축 **3시간 간격 7포인트**(현행 rack3d는 1시간 24포인트). 전산실 **전체 평균 1계열씩**(현행은 랙별 4계열 + 평균).

### G. 실시간 장애/이벤트 테이블 (279–321행)
컬럼 6종: 발생 시간 / 등급 / 대상 위치 / 장애 내용 / 담당자 / 상태
- 등급 배지 2종: `CRITICAL`(빨강) · `WARNING`(주황)
- 상태는 자유 텍스트 + 색: 조치 중 / 원인 분석 / 모니터링 / 발생(조치 대기)
- 담당자는 `김전산 차장`처럼 직급 포함 한글 이름
- **행 클릭 없음**(현행 rack3d는 클릭 시 3D 포커스 이동 — Q8)

### H. 랙 상세 모달 (326–334, 421–435행)
`width:360px` 소형 모달. 점유 유닛 / 실시간 전력 / 내부 온도 / 내부 습도 / 장착 장비(**Switch 2대가 하드코딩**, 428행).

---

## 4. 데이터 요구 매트릭스 (핵심 산출물)

판정 범례: ✅ 기존 API로 가능 / 🟡 FMS 신규 개발 필요 / 🔴 정의 자체가 필요 / ❓ 확인 필요

### 4-1. 랙·용량 계열

| 표시 항목 | 필요 데이터 | rack3d에 있나 | netis-fms에 있나 (근거) | 판정 |
|---|---|---|---|---|
| TOTAL RACKS | ZONE 하위 랙 수 | ✅ | ✅ `GET /api/zones/{zoneId}/racks` (E17) | ✅ |
| DEVICES | ZONE 하위 자산 수 | ✅ 서버만 | ✅ E4 자산 목록 / `RackSummary.assetCount` | ✅ |
| 랙별 점유 `40/42U (95%)` | 랙 총U·점유U | ✅ | ✅ E16 `rack_units` + `rack_start_u/end_u` | ✅ |
| KPI 총 U 점유 | 전 랙 합계 | ✅ | ✅ 클라이언트 합산 가능 | ✅ |
| 랙 상세 "Server 9대, Switch 2대" | 랙 내 타입별 대수 | ❌ 서버만 | ⚠️ `u-map` → `RackAsset.category` 7종. Server/Switch는 `SERVER`/`NETWORK`로 근사 | 🔴 매핑 정의 |
| 랙 3D 좌표 | grid x/z, facing | ✅ localStorage | ❌ **E18 미구현** | 🟡 E18 대기 |

### 4-2. 환경 계열

| 표시 항목 | rack3d에 있나 | netis-fms에 있나 | 판정 |
|---|---|---|---|
| **랙별 온도** | ❌ `createTemperatureHistory()`가 사인파로 **생성**하는 가짜값 | ⚠️ 모델상 가능(TH 자산을 RACK 노드에 매핑). **실제 그렇게 운영하는지 미확인, 랙 단위 집계 API 없음** | ❓ + 🟡 |
| **랙별 습도** | ❌ 습도 개념 자체 부재 | ⚠️ 동일 (`TH.humidity`) | ❓ + 🟡 |
| 전산실 평균 온도 | ⚠️ 정적 상수 | ✅ `ThRange.avgTemp` — `GET /api/performance/kpis?locationId=` | ✅ |
| 전산실 평균 습도 | ❌ | ✅ `ThRange.avgHumidity` | ✅ |
| 온도 목표 범위 | ❌ | ✅ `threshold_policies` (`OUT_OF_RANGE` + `bound_low/high`) | ✅ + 🔴 대표 정책 선택 규칙 |
| 습도 목표 범위 | ❌ | ✅ 동일 | ✅ + 🔴 |
| 온습도 24h 시계열 | ❌ **가짜 생성** | ⚠️ 원천은 있음(`measurement_rollups_hourly`). 그러나 `GET /api/performance/series`는 **`assetId` 단일 필수** → 다중 자산 평균 시계열 API 없음 | 🟡 |

### 4-3. 전력 계열

| 표시 항목 | rack3d에 있나 | netis-fms에 있나 | 판정 |
|---|---|---|---|
| **랙별 소비전력** | ❌ 히트맵 `power`는 하드코딩 10건 | ⚠️ 모델상 가능(DPM `active_power`). **`monitoring_type`에 `PDU` 없음**, 랙 PDU 등록 여부 미확인 | ❓ + 🟡 |
| 전산실 총 소비전력 | ❌ | ⚠️ `PowerLoad`는 `avg`/`max`만 있고 **합계 필드 없음** | 🟡 |
| 전력 용량 대비 % | ❌ | ❌ 전산실 설계 전력용량 컬럼이 스키마에 없음 | 🔴 |
| **PUE** | ❌ | ❌ PUE 언급 전무. IT부하/전체부하 계측점 구분 없음 | 🔴 + ❓ |

### 4-4. 시설 설비 6종

| 표시 항목 | rack3d에 있나 | netis-fms에 있나 | 판정 |
|---|---|---|---|
| UPS 부하 | ❌ | ✅ `UPS.active_power`, `out_load_r/s/t`, `battery_soc` (V12 시드) | ✅ / 🟡 kW 합계 |
| 소방 감지/방재 | ❌ | ⚠️ `FIRE`는 **감지기**(`smoke_density`/`heat_temp`/`fire_detected`). **가스계 소화설비 자체 상태 지표 없음** | ❓ |
| 항온항습기 #1/#2 | ❌ | ✅ `HVAC.temp`/`humidity` + `operating_state` + 경보접점 22종. `GET /api/performance/equipment?locationId=` | ✅ (N대 가변 재해석) |
| 누수 감지 | ❌ | ✅ `LEAK.leak_detected` + `AlarmKpi.detectedCount` | ✅ |
| 수배전반 | ❌ | ✅ `DPM.volt_r/volt_rs` 3상 전압 + `current_severity` | ✅ + 🔴 표기 규칙 |
| 설비 통신 상태 | ❌ | ✅ `asset_monitoring_statuses.comm_status` | ✅ |

### 4-5. 장비 구성 / 장애 계열

| 표시 항목 | rack3d에 있나 | netis-fms에 있나 | 판정 |
|---|---|---|---|
| 장비 타입 5분류 | ❌ 서버 모델 3종만 | ⚠️ `assets.category` 7종. **`SERVER`가 서버·스토리지 통합, x86/GPU 구분 없음** | 🔴 |
| 활성 장애 수 | ⚠️ 서버 status 파생(가짜) | ✅ `OpenTicketSummary` (E5) | ✅ |
| `Critical 1 · Warning 2` | ⚠️ | ⚠️ FMS는 **3단계**(`CRITICAL/MAJOR/CAUTION`), 시안은 **2단계** | ✅ + 🔴 매핑 |
| 장애 발생시간 / 대상 위치 / 내용 | ⚠️ 하드코딩 | ✅ `TicketRow.occurredAt`/`locationName`·`assetName`/`title` | ✅ |
| **담당자** | ⚠️ 하드코딩 | ✅ `tickets.assignee_name` | ✅ |
| **조치 상태** | ⚠️ boolean만 | ⚠️ FMS 4상태(`REGISTERED/IN_PROGRESS/RESOLVED/CLOSED`). **시안의 "원인 분석"·"모니터링"은 FMS에 없음** | ✅ + 🔴 매핑 |
| 서버 개별 상태 | ✅ 시드값 | ❌ **없음.** IT 장비 텔레메트리 미수집 | 🔴 파생 규칙 |
| 서버 상세(CPU/메모리/트래픽) | ⚠️ 하드코딩 10건 | ❌ 소스 없음 | 🔴 범위 제외 후보 |
| 랙 상태 4분류 임계값 | ❌ | ❌ FMS 관심사 아님 | 🔴 rack3d 자체 정의 |

### 4-6. 판정 집계

| 판정 | 건수 | 대표 항목 |
|---|---|---|
| ✅ 기존 API로 가능 | 14 | 랙 U 점유, 전산실 평균 온·습도, 임계 범위, HVAC/LEAK/DPM 상태, 티켓 전 필드 |
| 🟡 FMS 신규 개발 필요 | 6 | 랙 단위 환경/전력 집계, ZONE 평균 시계열, 전력 합계 필드, E18 좌표 |
| 🔴 정의 자체가 필요 | 9 | PUE, 전력 용량, 장비 5분류, 랙 상태 임계값, 등급·상태 매핑, 서버 상태 파생 |
| ❓ 확인 필요 | 4 | 랙별 TH 센서 배치, 랙 PDU 등록, FM-200 상태 소스, 검색 범위 |

---

## 5. netis-fms에 보낼 요청 (초안)

### A. 확인 요청

| # | 질문 | 왜 필요한가 |
|---|---|---|
| A1 | 랙마다 TH(온습도) 센서를 별도 자산으로 등록하고 `location_id`를 RACK 노드로 매핑하는 운영을 상정하나? 아니면 TH는 ZONE 단위 몇 개만 두나? | 시안 랙 카드가 랙별 온·습도를 표시. ZONE 단위뿐이면 랙별 표시가 원천 불가 |
| A2 | 랙 PDU 전력 미터를 자산으로 등록하는 사례가 있나? `monitoring_type`에 `PDU`가 없고 `DPM`으로 대체하는 구조가 맞나? | 랙별 소비전력의 유일한 소스 후보 |
| A3 | 전산실(ZONE)의 설계 전력 용량(계약전력, kW)을 저장하는 곳이 있나? | KPI "용량 대비 40.1%"의 분모 |
| A4 | PUE를 산출할 계측 구성(전체 시설전력 vs IT부하 분리)이 상정돼 있나? 검색 결과 PUE 언급 0건 | KPI PUE 카드. 불가하면 항목 제외 |
| A5 | 가스계 소화설비(FM-200) 운전 상태 데이터가 있나? `FIRE`는 감지기 지표로 보임 | "소방 감지/방재" 카드 |
| A6 | IT 장비(서버/스위치/스토리지) 단위 텔레메트리 수집 계획이 있나? | rack3d 기존 명세 §5.3·§7이 전부 이 전제 위에 있음. 계획 없으면 명세 개정 |
| A7 | `GET /api/dashboard/summary`에 위치(ZONE) 필터가 없는 게 맞나? | rack3d는 전산실 1개 기준 집계가 필수 |
| A8 | E18(layout-editor) 착수·완료 예정 시점 | 3D 좌표가 E18에 종속 |

### B. 신규 개발 요청

| # | 요청 | 근거 |
|---|---|---|
| B1 | **랙 단위 환경·전력 집계** — 기존 `GET /api/zones/{zoneId}/racks` 응답에 `temp`/`humidity`/`powerKw`/`severity`/`collectedAt`/`stale` 필드 추가 선호 | 랙 36개를 한 화면에 그림. 개별 호출 시 36 N+1 |
| B2 | **ZONE 스코프 대시보드 요약** — `GET /api/dashboard/summary?locationId={zoneId}` 지원 | KPI 5카드 + 시설 6카드가 전부 전산실 한정 집계 |
| B3 | **전력 합계 필드** — `PowerLoad`에 `sumActivePowerKw`, `sumUpsActivePowerKw` 추가 | KPI는 평균이 아니라 합계 |
| B4 | **다중 자산 평균 시계열** — `locationId + monitoringType + metricCodes` 로 ZONE 평균 시계열 | 시안 온습도 트렌드는 전산실 평균 1계열 |
| B5 | 랙 목록에 `categoryCounts` 요약 | 랙 상세 모달 "Server 9대, Switch 2대" |
| B6 | 티켓 목록의 ZONE(서브트리) 필터 | 하단 장애 테이블 = 이 전산실 미조치 티켓 |

### C. 규격 협의

| # | 항목 | rack3d 제안 |
|---|---|---|
| C1 | 등급 매핑: FMS 3단계 ↔ 시안 2배지 | `CRITICAL`→CRITICAL, `MAJOR`+`CAUTION`→WARNING |
| C2 | 상태 표기: FMS 4상태 ↔ 시안 문구 | FMS 4상태를 SSOT로, rack3d가 한글 라벨만 매핑. 시안의 "원인 분석"·"모니터링"은 버림 |
| C3 | 장비 분류: 시안 5분류 ↔ FMS `category` 7종 | FMS 7종을 SSOT로 도넛 재해석. 세분 필요 시 `custom_attrs` 키 규약 협의 |
| C4 | 환경 목표 범위 출처 | 유형 기본값(`asset_id IS NULL`) + `OUT_OF_RANGE` 정책을 대표로 |
| C5 | 인증·CORS | E17 텍스처 요청의 R2·R3와 동일 사안이 **대시보드 API 전체로 확대**. E19에서 함께 처리 |
| C6 | BFF 필요 여부 | 사용자 결정 대기(Q6). FMS는 읽기 API 그대로 노출 전제로 진행 무방 |

---

## 6. 미확정 결정 항목 (PM → 사용자 인터뷰)

| # | 질문 | 선택지 | 추천 |
|---|---|---|---|
| Q1 | 대시보드 표시 형태 | (a) 현행 슬라이드 패널 / (b) 전체화면 오버레이 / (c) 별도 라우트 | **(b)** — 시안은 세로로 긴 전체 페이지. 패널 폭에서는 6열 랙 그리드·이중축 차트가 무너짐. (c)는 라우터 도입 비용 + 3D 컨텍스트 상실 |
| Q2 | 비주얼 톤 | (a) 목업 그대로 / (b) 구조는 시안 100%, 색·폰트는 rack3d 토큰 재해석 / (c) 다크 전용 | **(b)** — (a)면 다크 3D에서 열 때 화면이 하얗게 번쩍이고 기존 테마 토글이 무력화됨. 시안의 가치는 정보 구조에 있음 |
| Q3 | 차트 라이브러리 | (a) echarts 통일 / (b) Chart.js 병행 / (c) Chart.js 통일 | **(a)** — echarts가 이미 의존성이고 테마 연동·ResizeObserver·aria까지 붙어 있음. 시안이 쓰는 기능(도넛·이중축·점선·면적)은 전부 기본 기능 |
| Q4 | CDN 의존(Fonts/FontAwesome/Chart.js) | (a) 전부 제거 / (b) npm 패키지화 / (c) CDN 유지 | **(a)** — (c)는 **폐쇄망 납품에서 즉사**. rack3d는 현재 외부 CDN 의존 0개이며 아이콘을 전부 인라인 SVG로 그림 |
| Q5 | 미연동 항목 처리 | (a) 미연동 배지+비활성 / (b) 자리 유지 + `—` + 출처 배지 / (c) 항목 제외 / (d) 더미값 유지 | **(b)** — (d)는 관제 화면에서 가장 위험(가짜 온도를 진짜로 읽음). 현행 rack3d가 이미 이 함정에 빠져 있음 |
| Q6 | 백엔드 구조 | (a) FMS 직접 호출 / (b) rack3d BFF / (c) FMS 안에 rack3d 전용 묶음 | ✅**확정 (2026-08-21, 사용자)**: "rack3d는 netis-fms에서 API를 통해 거의 모든 데이터를 가져와야 한다" → **netis-fms가 데이터 SSOT**. rack3d는 자체 데이터 소스를 갖지 않는다. 호출 형태는 (a) 직접 호출 기본, A7·B2 답변에 따라 (c) 재검토 가능 |
| Q7 | 랙 상태 4분류 임계값 | (a) 점유율 0 / 1–30 / 31–79 / 80↑ / (b) 점유율+온도 복합 / (c) FMS 정책 | **(a)** — 목업이 생성한 분포에서 역산한 값이라 시안 색 분포와 일치. 목업에 규칙 자체가 없음 |
| Q8 | 장애 행 클릭 | (a) 3D 포커스 이동 유지 / (b) 클릭 없음 / (c) 상세 모달 | **(a)** — 3D 시각화 제품의 존재 이유. 시안이 2D 목업이라 없을 뿐 |

---

## 6-1. 확정된 결정

### D1. 데이터 소유권 — netis-fms가 SSOT ✅확정 (2026-08-21, 사용자)

사용자 원문: "rack3d 는 netis-fms 에서 api를 통해 거의 모든 데이터를 가져와야 해."

- rack3d는 **자체 데이터 소스를 갖지 않는다.** 현재의 시드 데이터(`src/rackLayouts.ts`), 하드코딩 프로필(`serverProfiles`), 생성 함수(`createTemperatureHistory`)는 전부 임시물이며 제거 대상이다.
- 3D 배치 좌표의 localStorage 저장도 최종 형태가 아니다 — E18 완료 시 FMS 좌표로 대체한다(S4).
- **따라잡히는 귀결**: netis-fms에 없는 데이터는 rack3d 화면에서 표시할 수 없다. 4-5의 🔴 "서버 개별 상태", "서버 상세(CPU/메모리/트래픽)"와 §2의 히트맵 3모드가 여기 걸린다. FMS가 IT 장비 텔레메트리를 수집하지 않는 한(A6), 해당 기능은 **소스가 영구히 없다.**
- 따라서 A6(FMS의 IT 장비 텔레메트리 수집 계획)는 단순 확인이 아니라 **rack3d 기능 범위를 결정하는 질문**이다.

### D2. 진행 기준 — FMS가 줄 수 있는 데이터 우선 ✅확정 (2026-08-21, 사용자)

사용자 원문: "일단 fms 쪽에서 데이터를 줄 수 있는거 위주로 먼저 하기로 했어. rack3d 대시보드 템플릿 준거를 고집할 필요 없이."

- 확정 시안(`3D_dashboard.html`)은 **참고 기준으로 강등**한다. 시안 항목을 그대로 재현하는 것을 목표로 삼지 않는다.
- 구현 순서는 **§4 매트릭스의 ✅ 14건(기존 API로 가능)** 을 1순위로 한다. 🟡(FMS 신규)·🔴(정의 필요)는 후순위.
- §6 Q1~Q5·Q7의 상당수(시안 충실도 관련)는 이 결정으로 무게가 줄었다. 레이아웃은 "가능한 데이터"에 맞춰 재구성한다.
- 관리자 결정 요청 5건(서버 상태·랙별 센서·PUE·소화설비·장비 분류)은 **병렬로 대기**하되, 그 답을 기다리지 않고 진행한다.

### D3. 가짜 데이터 제거 + FMS 실연동 ✅확정 (2026-08-21, 사용자)

사용자 원문: "현재 가짜데이터로 데모처럼 작동하고 있는데 이제 fms 에 접속해서 api를 통해 데이터를 가져 와서 적용하는걸로 해야 해."

- 시드 데이터(`src/rackLayouts.ts`), 하드코딩 프로필(`serverProfiles`, `initialIncidentRecords`), 생성 함수(`createTemperatureHistory`)를 제거하고 FMS API 호출로 대체한다.
- **선행 검토 필요**: 인증(로그인 필요 여부), 토큰 취급, CORS, 권한·위치 스코프, 배포 오리진. → §10 참조.

### D4. 배포 오리진 — FMS와 같은 오리진 하위 경로 ✅확정 (2026-08-21, 사용자)

`https://<fms>/rack3d/` 로 서빙한다. FMS 프론트 nginx에 `location /rack3d/ { proxy_pass ... }` 1블록 추가, rack3d는 `vite.config.ts`에 `base: '/rack3d/'`.

- **해소되는 것**: CORS 신설 불필요, 리프레시 쿠키(`SameSite=Strict`) 정상 동작, SSE 동작, 이미지 텍스처는 fetch→blob으로 처리 → **E17 R2(이미지 토큰)·R3(CORS) 요청이 통째로 불필요**, FMS 보안 헤더 스니펫 상속.
- **제약**: FMS CSP가 `connect-src 'self' blob:` 이므로 **외부 CDN 도입 금지 방침을 계속 유지**해야 한다(위반 시 운영에서만 깨진다). `frame-ancestors 'none'` 이라 iframe 삽입 불가.
- 상세: `fms-integration-security.md` §9 권장안 A

## 7. 단계 분할

**결론: UI 교체 선행이 현실적이며 권장한다.**
1. FMS 의존 항목이 UI 구조를 바꾸지 않는다 — 값이 `—`든 실측이든 레이아웃 동일
2. FMS 선행 조건이 길다 — E18은 🔵 기획 중, B1~B4는 A1~A7 답변 후 착수
3. UI를 먼저 만들면 그 자체가 조율 도구가 된다

**단, 조건**: 더미값을 실측처럼 표시하지 않는다(Q5-b). 이번 교체 때 `createTemperatureHistory` 를 함께 제거할 것을 권한다.

| 단계 | 범위 | FMS 의존 | 난이도 |
|---|---|---|---|
| **S1. UI 교체** | 시안 8영역 전체 React 구현. 로컬 데이터로 채울 수 있는 것만 실값, 나머지 `—`+미연동 배지. echarts 도넛·이중축. 랙 모달·범례 필터·검색 | **없음** | M (2~3일) |
| **S2. 데이터 계약 확정** | 요청서 전달 → A1~A8 답변 → C1~C6 협의 → `rack3d-api-spec.md` §5.3·§7 + OpenAPI 개정 | 전면 | S (문서, 왕복 대기 지배적) |
| **S3-a. 즉시 연동분** | ✅ 14건 연결(랙 U 점유, 평균 온·습도, 임계 범위, 시설 카드, 티켓 테이블) | 기존 API만 | M (인증·CORS 해결 후 2~3일) |
| **S3-b. 신규 대기분** | 🟡 6건(랙별 환경·전력, ZONE 요약, 전력 합계, 평균 시계열) | FMS 신규 | M (1~2일) |
| **S3-c. 정의 대기분** | 🔴 9건(PUE·전력용량·장비 5분류 등) | 사용자·FMS 결정 | S~M |
| **S4. 3D 좌표 연동** | E18 `zone_layout_object` → 3D 배치, localStorage 대체 | E18 필수 | L |

**S1 진입 조건**: Q1~Q5(+Q7) 결정 완료. Q6·Q8은 S2까지 미뤄도 무방.
**전체 예상**: S1+S2+S3-a ≈ 1~1.5주 (FMS 왕복 대기 제외).

---

## 8. 리스크

| # | 리스크 | 영향 | 완화 |
|---|---|---|---|
| R1 | **랙별 TH/DPM 센서가 실제로는 미설치 구성**일 수 있음(A1·A2 미확인) → 랙 카드 메트릭 3종 전부 영구 공백 | 🔴 높음 | A1·A2 최우선 확인. 불가 시 랙 카드를 "점유율+장애 수" 중심으로 재설계 |
| R2 | **가짜 데이터가 실측으로 오인.** 현행 rack3d에 이미 존재하는 문제(사인파 온도) | 🔴 높음 | Q5-b + `createTemperatureHistory` 제거 + 출처 배지 |
| R3 | 기존 API 명세 2종(1108행+2146행) 사문화 가능 | 🟡 중간 | Q6 결정 후 "FMS 소비 계약"으로 성격 전환. 폐기 말고 개정 |
| R4 | 화면당 API 호출 4~6회 + 폴링 → FMS 부하 | 🟡 중간 | FMS 폴링 규약(10초/30초) 준수, 랙 목록은 30초 이상. B1을 "필드 추가"로 요청한 이유 |
| R5 | **인증·CORS 미해결**. E17에서 제기한 R2·R3가 E19로 이연된 상태 | 🔴 높음 | S2에서 C5로 협의. rack3d 오리진 확정 선행 |
| R6 | 등급·상태 매핑을 rack3d가 자의적으로 정하면 FMS 화면과 표기 불일치 | 🟡 중간 | C1·C2 합의, FMS를 SSOT로 |
| R7 | 시안이 항온항습기 2대 고정 → N대 가변 시 레이아웃 깨짐 | 🟢 낮음 | 리스트 렌더 + 스크롤 |
| R8 | 검색 placeholder("Rack, 서버, 장애")와 구현(랙 ID만) 불일치 | 🟢 낮음 | 기존 `AssetSearch` 로직 재사용으로 확장 |

---

## 9. 참고 경로

- 확정 시안: `/Volumes/ext-ssd/4.Test/fms/3D_dashboard.html`
- rack3d 현행: `src/App.tsx` (`DataCenterDashboard` 1789, `getDashboardMetrics` 420, `createTemperatureHistory` 465, `TemperatureHistoryChart` 1671, `getRackHeatmapValue` 353, `serverProfiles` 132, `initialIncidentRecords` 185), `src/rackLayouts.ts`
- rack3d 명세: `docs/rack3d-api-spec.md` (§5.3 519행, §7 990행), `docs/openapi/rack3d-v1.yaml`
- FMS 지표 시드: `netis-fms/backend/src/main/resources/db/migration/V12__seed_data.sql` (39–133행)
- FMS 스키마: `netis-fms/docs/DB-SCHEMA.md` (§5-1, §6-2, §6-5, §6-6, §7-2)
- FMS 성능: `.../performance/dto/PerformanceDtos.java` (`ThRange` 136, `PowerLoad` 145, `Kpis` 88), `.../performance/PerformanceController.java` (`/kpis` 98, `/series` 106)
- FMS 대시보드: `.../dashboard/DashboardController.java` (`/summary` 37행 — locationId 없음)
- FMS 랙맵(E17 구현됨): `.../asset/RackMapController.java`, `.../asset/dto/RackMapDtos.java`
- FMS 기획서: `netis-fms/docs/EPIC-E17-E18-rack-layout.md`, `netis-fms/docs/BACKLOG.md`

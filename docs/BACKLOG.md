# Backlog

이 파일은 프로젝트 작업의 단일 기준(SSOT)이다.

## 할 일

- [ ] 실제 Rack3D API 연동 구현
- [ ] polling, stale/error/loading UI 구현
- [ ] SSE 기반 실시간 갱신 검토
- [ ] 🔵 netis-fms 장비 실물 이미지(FRONT/REAR)를 3D 랙 장비 앞뒤면 텍스처로 실시간 표시
  - 2026-08-21 PM 검토 완료: **재모델링 불필요**. 현재 GLB가 이미 `섀시 + 앞면 사진 평면 + 뒷면 사진 평면` 구조라(`*_PhotoFront`/`*_PhotoRear` 머티리얼) 런타임 텍스처 교체로 구현 가능. 진입점 `src/App.tsx:500 cloneModel()`
  - 부수효과: GLB 없는 장비(스위치/스토리지/PDU)도 "U높이 + 앞뒤 사진"으로 표현 가능 → 장비 확장이 모델링을 유발하지 않음
  - **선행 조건(netis-fms E17 계약)**: 요구사항 문서를 netis-fms에 전달함 → `netis-fms/docs/EPIC-E17-rack3d-texture-consumption.md`
    - R1 텍스처용 축소본 엔드포인트(필수) — 원본 30MB 그대로는 GPU 7.6GB로 브라우저 크래시
    - R2 헤더 없이 접근 가능한 인증(필수) — netis-fms CCTV 스트림 토큰 패턴 재사용 제안
    - R3 CORS 허용(필수) / R4 이미지 sha·updatedAt 노출 / R5 정면 크롭 가이드
  - 계약 확정 전까지 대기. 확정 시 planner부터 파이프라인 진행

## 완료

- [x] 2026-08-05 2D 랙 배치 에디터 씬 추가 — 전산실별 2D 배치(추가/이동/회전/삭제/라벨) → localStorage 저장 → 3D 씬 반영. 진입: 3D 씬 상단바 LAYOUT EDIT 버튼

- [x] Rack3D MVP 데이터 8개 + 인증 4개 REST API 한국어 명세 작성 (`docs/rack3d-api-spec.md`)
- [x] Rack3D API 간단 명세 작성 (`docs/rack3d-api-spec-simple.md`)
- [x] Rack3D 데이터/인증 OpenAPI 3.1 계약 작성 (`docs/openapi/rack3d-v1.yaml`)

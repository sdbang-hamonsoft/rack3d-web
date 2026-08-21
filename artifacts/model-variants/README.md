# 모델 변종 보관소 (배포 대상 아님)

`public/`은 **빌드 산출물에 그대로 복사되는 디렉터리**다. 런타임이 쓰지 않는 모델 변종을
거기 두면 운영 이미지에 그대로 실린다(정리 전 `dist/` 59MB 중 미사용 GLB가 47MB였다).

여기 있는 파일은 작업용 보관본이다 — `.dockerignore`가 `artifacts`를 제외하므로 배포되지 않는다.

- `*.prev.glb` — 모델 교체 전 백업본 (`docs/cisco-c240-m7-modeling-brief.md` 관행)
- `*.rodin.glb` / `*.procedural.glb` — 생성 방식별 실험 산출물

`cisco-ucs-c240-m7.tripo.glb`는 `artifacts/tripo/cisco-ucs-c240-m7/pbr_model.glb`와
바이트 동일(md5 `33f5ff24f076e7d2297f11f024c0d17a`)이라 사본을 늘리지 않고 그쪽만 남겼다.

**런타임이 쓰는 모델은 `public/models/`의 4개뿐이다**:
`rack-42u.glb`, `dell-poweredge-r760.glb`, `hpe-proliant-dl360-gen11.glb`, `cisco-ucs-c240-m7.glb`

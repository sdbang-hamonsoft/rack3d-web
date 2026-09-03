"""가스 소화 설비 (FMS type: GAS).

레퍼런스: `artifacts/reference/fms-object-3d-guide.jpg` 의 "가스 소화 설비" —
적색 실린더 4본이 나란히 서고, 위쪽 매니폴드 배관으로 묶이며, 끝에 압력계가 달린다.
사양(엑셀 시트1): 실린더 `#C0392B` / 배관 `#D35400`, Metallic 0.8, Roughness 0.2
("고광택 반사: 강철 용기 표현").

⚠️ **압력계 눈금과 "42 Bar" 숫자는 넣지 않는다.** 레퍼런스에 적혀 있지만 FMS 는 이
   설비의 압력을 주지 않는다. 계기 형상만 만들고 문자판은 비운다(§7-2 와 같은 이유).

⚠️ **현행 `LAYOUT_OBJECT_HEIGHTS_M['GAS'] = 0.3` 과 충돌한다.** 0.3m 실린더는 우스꽝스럽다.
   씬 통합 때 이 모델 실측 높이로 교체한다(§4-B).

실측 치수는 아직 없다(회사 자료 대기). 일반적인 68L급 소화약제 용기 근사치다.

실행:
  Blender --background --factory-startup --python blender/objects/gas_suppression.py \
    -- public/models/objects/gas-suppression.glb
"""

import os
import sys

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
from _common import (  # noqa: E402
    bevel_all, box, cylinder, export_glb, material, report, reset_scene, srgb,
)

CYL_COUNT = 4
CYL_R = 0.125
CYL_PITCH = 0.27
CYL_H = 1.15
SKID_H = 0.05
MANIFOLD_Z = 1.38
DEPTH = 0.32

WIDTH = (CYL_COUNT - 1) * CYL_PITCH + CYL_R * 2

reset_scene()

steel_red = material("gas_cylinder", srgb("#C0392B"), metallic=0.80, roughness=0.20)
pipe = material("gas_pipe", srgb("#D35400"), metallic=0.80, roughness=0.25)
hardware = material("gas_hardware", srgb("#6E767E"), metallic=0.85, roughness=0.30)
dark = material("gas_frame", srgb("#2A2E33"), metallic=0.80, roughness=0.35)
dial = material("gas_gauge_dial", srgb("#E6E9EB"), metallic=0.05, roughness=0.45)

parts = []

# --- 바닥 스키드 + 후면 지지 프레임 ---
parts.append(box("skid", (WIDTH + 0.06, DEPTH, SKID_H), (0, 0, SKID_H / 2), dark))
# 후면 지지대는 **통짜 패널이 아니라 기둥 2 + 상단 레일**이다.
# 1차본은 1.26 x 1.09m 짜리 판이었는데, 씬에서 오브젝트가 뒤를 보고 있으면(`dir`)
# 그 판이 카메라를 정면으로 막아 **용기가 하나도 안 보였다.** 사용자가 자유롭게 도는
# 씬이라 뒤에서 봐도 무엇인지 읽혀야 한다.
post_h = CYL_H * 0.95
for i, sx in enumerate((-1, 1)):
    parts.append(box(f"back_post_{i}", (0.045, 0.035, post_h),
                     (sx * (WIDTH / 2 - 0.02), DEPTH / 2 - 0.02, SKID_H + post_h / 2), dark))
parts.append(box("back_rail", (WIDTH + 0.06, 0.035, 0.055),
                 (0, DEPTH / 2 - 0.02, SKID_H + post_h - 0.028), dark))

x0 = -WIDTH / 2 + CYL_R

for i in range(CYL_COUNT):
    x = x0 + i * CYL_PITCH
    base_z = SKID_H
    # 용기 본체
    parts.append(cylinder(f"cylinder_{i}", CYL_R, CYL_H, (x, 0, base_z + CYL_H / 2),
                          steel_red, segments=20))
    # 어깨(상단 돔) — 원기둥 위에 얹은 짧고 좁은 원기둥으로 대신한다(구는 폴리곤이 비싸다)
    parts.append(cylinder(f"shoulder_{i}", CYL_R * 0.72, 0.075,
                          (x, 0, base_z + CYL_H + 0.036), steel_red, segments=20))
    # 밸브 넥
    parts.append(cylinder(f"valve_{i}", 0.028, 0.10, (x, 0, base_z + CYL_H + 0.12),
                          hardware, segments=12))
    # 매니폴드로 올라가는 연결관
    parts.append(cylinder(f"riser_{i}", 0.018, MANIFOLD_Z - (base_z + CYL_H + 0.16),
                          (x, 0, (MANIFOLD_Z + base_z + CYL_H + 0.16) / 2), pipe, segments=10))

# --- 매니폴드 배관 (가로) + 끝단 캡 ---
parts.append(cylinder("manifold", 0.032, WIDTH + 0.10, (0, 0, MANIFOLD_Z), pipe,
                      segments=16, axis="X"))
for i, sx in enumerate((-1, 1)):
    parts.append(cylinder(f"manifold_cap_{i}", 0.038, 0.030,
                          (sx * (WIDTH + 0.10) / 2, 0, MANIFOLD_Z), hardware,
                          segments=16, axis="X"))

# --- 압력계 (우측 끝) — 문자판은 비운다 ---
gauge_x = WIDTH / 2 + 0.02
parts.append(cylinder("gauge_stem", 0.014, 0.09, (gauge_x, -0.05, MANIFOLD_Z - 0.045),
                      hardware, segments=10))
parts.append(cylinder("gauge_case", 0.055, 0.032, (gauge_x, -0.10, MANIFOLD_Z - 0.09),
                      hardware, segments=20, axis="Y"))
parts.append(cylinder("gauge_dial", 0.044, 0.008, (gauge_x, -0.118, MANIFOLD_Z - 0.09),
                      dial, segments=20, axis="Y"))

# 고정 밴드(스트랩)는 **넣지 않는다.** 용기 앞면에 가로바를 걸었더니 난간처럼 보여
# 실루엣을 해쳤고, 레퍼런스에도 밖으로 드러난 밴드가 없다. 뒤 프레임이 지지 역할을 읽어준다.

for part in parts:
    bevel_all(part, width=0.0015)

stats = report(
    "gas-suppression", limit=1.25,
    limit_reason=f"소화약제 용기 {CYL_COUNT}본 뱅크라 가로로 길다({WIDTH:.2f}m). 한 칸에 넣으려면 "
                 "용기를 1본으로 줄여야 하는데 그러면 '가스 소화 설비'로 안 읽힌다.",
)

out = sys.argv[sys.argv.index("--") + 1]
os.makedirs(os.path.dirname(out), exist_ok=True)
export_glb(out)
print(f"[gas-suppression] wrote {out} ({os.path.getsize(out):,} bytes)")
if stats["problems"]:
    sys.exit(1)

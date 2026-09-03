"""배터리 랙 (FMS type: BATTERY — 신설 요청 중, §4).

레퍼런스: `artifacts/reference/fms-object-3d-guide.jpg` 의 "배터리 랙(Battery Rack)" +
`artifacts/reference/FMS-관리오브젝트-3D모델링.xlsx` (BaseColor #2C3E50, Metallic 0.7, Roughness 0.3).
열린 프레임에 배터리 모듈 12단. 모듈 전면에 손잡이 홈과 상태 LED.

실행:
  /Applications/Blender.app/Contents/MacOS/Blender --background --factory-startup \
    --python blender/objects/battery_rack.py -- public/models/objects/battery-rack.glb
"""

import os
import sys

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
from _common import (  # noqa: E402
    bevel_all, box, cylinder, export_glb, material, report, reset_scene, srgb,
)

# 실물 대략치. FMS 는 물리 치수를 주지 않으므로 이 값은 형상 비율용이고
# 화면에 숫자로 나가지 않는다(§2).
WIDTH, DEPTH, HEIGHT = 0.46, 0.44, 1.55
MODULE_COUNT = 12
MODULE_H = 0.098
MODULE_GAP = 0.012
POST = 0.036
BASE_H = 0.06

reset_scene()

steel = material("frame_steel", srgb("#2C3E50"), metallic=0.70, roughness=0.30)
module_body = material("battery_body", srgb("#B9BEC4"), metallic=0.70, roughness=0.30)
module_face = material("battery_face", srgb("#22252A"), metallic=0.60, roughness=0.35)
handle = material("battery_handle", srgb("#6E767E"), metallic=0.75, roughness=0.35)
# ⚠️ **발광시키지 않는다.** 사양서는 정상 Green / 장애 Red 전환을 요구하지만 FMS 는 이
# 오브젝트의 상태를 주지 않는다. 전부 초록으로 켜 두면 "전부 정상"이라고 말하는 것이고
# 그건 지어내기다(C6 — 형상은 근사여도 되지만 상태·글자는 실값이어야 한다).
# 상태 데이터가 생기면 그때 emission 을 붙인다. 지금은 렌즈 형상만.
led = material("battery_led_lens", srgb("#8A9199"), metallic=0.15, roughness=0.40)

parts = []

# --- 받침대 ---
parts.append(box("base", (WIDTH, DEPTH, BASE_H), (0, 0, BASE_H / 2), steel))

# --- 코너 포스트 4개 ---
post_h = HEIGHT - BASE_H
for ix, sx in enumerate((-1, 1)):
    for iy, sy in enumerate((-1, 1)):
        parts.append(box(
            f"post_{ix}{iy}", (POST, POST, post_h),
            (sx * (WIDTH / 2 - POST / 2), sy * (DEPTH / 2 - POST / 2), BASE_H + post_h / 2),
            steel,
        ))

# --- 상단 캡 ---
parts.append(box("top_cap", (WIDTH, DEPTH, 0.028), (0, 0, HEIGHT - 0.014), steel))

# --- 후면 패널 (뒤에서 봤을 때 속이 비어 보이지 않게) ---
# 정면은 Blender -Y 이므로 후면은 +Y 다.
parts.append(box("back_panel", (WIDTH - POST * 2, 0.010, post_h - 0.03),
                 (0, DEPTH / 2 - POST - 0.005, BASE_H + post_h / 2 - 0.015), steel))

# --- 배터리 모듈 12단 ---
module_w = WIDTH - POST * 2 - 0.008
module_d = DEPTH - POST - 0.02
stack_h = MODULE_COUNT * MODULE_H + (MODULE_COUNT - 1) * MODULE_GAP
z0 = BASE_H + (post_h - 0.03 - stack_h) / 2  # 프레임 안에서 세로 중앙

for i in range(MODULE_COUNT):
    z = z0 + i * (MODULE_H + MODULE_GAP) + MODULE_H / 2
    parts.append(box(f"module_{i:02d}", (module_w, module_d, MODULE_H), (0, 0.01, z), module_body))
    # 전면 페이스 (살짝 돌출)
    face_y = -DEPTH / 2 + 0.012
    parts.append(box(f"module_face_{i:02d}", (module_w - 0.006, 0.016, MODULE_H - 0.008),
                     (0, face_y, z), module_face))
    # 손잡이 — 페이스 좌측 세로 바
    parts.append(box(f"module_handle_{i:02d}", (0.055, 0.012, MODULE_H - 0.030),
                     (-module_w / 2 + 0.045, face_y - 0.012, z), handle))
    # 상태 LED — 페이스 우측 점
    parts.append(cylinder(f"module_led_{i:02d}", 0.0055, 0.006,
                          (module_w / 2 - 0.030, face_y - 0.010, z), led, segments=10, axis="Y"))

for part in parts:
    if part.name.startswith("module_led"):
        continue  # 지름 5mm 원기둥에 베벨은 낭비다
    bevel_all(part)

stats = report("battery-rack")

out = sys.argv[sys.argv.index("--") + 1]
os.makedirs(os.path.dirname(out), exist_ok=True)
export_glb(out)
print(f"[battery-rack] wrote {out} ({os.path.getsize(out):,} bytes)")
if stats["problems"]:
    sys.exit(1)

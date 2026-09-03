"""항온항습기 (FMS type: CRAC).

레퍼런스: 사용자 제공 `FMS 관리오브젝트 3D모델링.xlsx` 시트 "항온항습기".
기준 기종 **STULZ CyberAir 3 PRO DX**, 실측 바운딩 1200 x 890 x 1980 mm.
3면도/아이소메트릭은 그 파일의 내장 이미지(image2/image3.png)를 봤다.

⚠️ **1타일(600mm)을 넘는다** — 폭 1.2m 는 2타일, 깊이 0.89m 는 1.5타일이다.
   실물 비율을 지키려고 넘긴다. 선례가 있다: `rack-42u.glb` 도 깊이 1.0m 로 이미 1.67타일이다.

⚠️ **LCD 에 숫자를, LED 에 상태색을 넣지 않는다.** 사양서는 실시간 온/습도(22.5°C / 50%RH)
   표시와 정상 Green / 경보 Red 전환을 요구하지만, FMS 는 이 오브젝트의 텔레메트리를 주지 않는다.
   ZONE 온습도 시리즈는 있어도 그건 존 센서값이지 이 장비의 값이 아니다 —
   장비 화면에 띄우면 남의 값을 이 장비 값처럼 보이게 한다. 화면은 꺼진 유리, LED 는 무채색 렌즈다.

실행:
  Blender --background --factory-startup --python blender/objects/precision_ac.py \
    -- public/models/objects/precision-ac.glb
"""

import os
import sys

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
from _common import (  # noqa: E402
    bevel_all, box, cylinder, export_glb, material, report, reset_scene, srgb,
)

WIDTH, DEPTH, HEIGHT = 1.20, 0.89, 1.98
CABINET_W = WIDTH / 2          # 제어부 + 응축부 2연 캐비닛 (레퍼런스 이미지)
PLINTH_H = 0.09                # 하부 베이스 프레임 (차콜)
TOP_H = 0.03

FRONT = -DEPTH / 2             # Blender -Y 가 정면


def surface(thickness, protrude, on=0.0):
    """정면에 붙는 판/부품의 y 중심.

    ⚠️ 정면이 **-Y** 라서 "앞으로 나온다"는 y 가 **작아지는** 것이다.
    1차본에서 `FRONT + 0.009` 로 썼다가 그릴과 필터 도어가 통째로 캐비닛 **안쪽**에 박혀
    렌더에 아무것도 안 나왔다. 부호를 손으로 쓰지 말고 이 함수를 쓴다.

    thickness: 부품 두께(m).
    protrude: 자기가 올라앉은 면 밖으로 나오는 길이(m). thickness 이하여야 붙어 있다.
    on: 올라앉은 면이 이미 정면 밖으로 나와 있는 길이(m). 베젤 위의 유리, 도어 위의 손잡이용.
    """
    assert protrude <= thickness, "돌출이 두께보다 크면 본체에서 떨어져 뜬다"
    return FRONT - on - protrude + thickness / 2

reset_scene()

# 사양서 값 그대로. sRGB → 선형 변환은 srgb() 가 한다.
shell = material("pac_shell", srgb("#E2E6E8"), metallic=0.80, roughness=0.30)
charcoal = material("pac_charcoal", srgb("#2A2E33"), metallic=0.80, roughness=0.35)
glass = material("pac_lcd_glass", srgb("#0E1114"), metallic=0.10, roughness=0.10)
lens = material("pac_led_lens", srgb("#8A9199"), metallic=0.15, roughness=0.40)
copper = material("pac_copper", srgb("#B0703A"), metallic=0.90, roughness=0.35)

parts = []
body_h = HEIGHT - PLINTH_H - TOP_H
body_z = PLINTH_H + body_h / 2

# --- 하부 베이스 프레임 + 상부 캡 ---
parts.append(box("plinth", (WIDTH - 0.02, DEPTH - 0.02, PLINTH_H),
                 (0, 0, PLINTH_H / 2), charcoal))
parts.append(box("top_cap", (WIDTH, DEPTH, TOP_H), (0, 0, HEIGHT - TOP_H / 2), shell))

# --- 캐비닛 2연 ---
for index, sign in enumerate((-1, 1)):
    parts.append(box(f"cabinet_{index}", (CABINET_W - 0.006, DEPTH, body_h),
                     (sign * CABINET_W / 2, 0, body_z), shell))
# 두 캐비닛 사이 이음매
parts.append(box("seam", (0.014, DEPTH + 0.002, body_h), (0, 0, body_z), charcoal))

# ---------------------------------------------------------------- 좌: 제어 캐비닛
cx = -CABINET_W / 2

# LCD 베젤 + 유리 (C7000 컨트롤러)
bezel_z = PLINTH_H + body_h * 0.80
parts.append(box("lcd_bezel", (0.30, 0.020, 0.225), (cx, surface(0.020, 0.012), bezel_z), charcoal))
parts.append(box("lcd_glass", (0.255, 0.010, 0.180), (cx, surface(0.010, 0.006, on=0.012), bezel_z), glass))

# 상태 LED 4개 — 발광시키지 않는다(위 주의). 렌즈 형상만.
for i in range(4):
    parts.append(cylinder(f"status_led_{i}", 0.0075, 0.006,
                          (cx - 0.045 + i * 0.030, surface(0.006, 0.005), bezel_z - 0.155),
                          lens, segments=10, axis="Y"))

# 필터 도어 (하부) — 살짝 들어간 패널 + 가로 손잡이
door_h = body_h * 0.46
door_z = PLINTH_H + door_h / 2 + 0.05
parts.append(box("filter_door", (CABINET_W - 0.09, 0.016, door_h),
                 (cx, surface(0.016, 0.010), door_z), shell))
parts.append(box("filter_door_handle", (0.10, 0.022, 0.016),
                 (cx + 0.16, surface(0.022, 0.018, on=0.010), door_z + door_h * 0.30), charcoal))

# 도어 힌지·래치 (좌우 모서리)
for i, hz in enumerate((door_z + door_h * 0.42, door_z - door_h * 0.42)):
    for j, hx in enumerate((cx - CABINET_W / 2 + 0.035, cx + CABINET_W / 2 - 0.035)):
        parts.append(box(f"latch_{i}{j}", (0.030, 0.020, 0.045),
                         (hx, surface(0.020, 0.014), hz), charcoal))

# ---------------------------------------------------------------- 우: 응축/흡기 캐비닛
gx = CABINET_W / 2

# 타공 그릴 — 노멀맵 대신 얕은 슬랫 지오메트리로 낸다(텍스처 0장 규약, §2).
def louver_band(name, center_z, band_h, slat_count=9):
    pitch = band_h / slat_count
    for i in range(slat_count):
        z = center_z - band_h / 2 + pitch * (i + 0.5)
        parts.append(box(f"{name}_slat_{i:02d}", (CABINET_W - 0.10, 0.014, pitch * 0.52),
                         (gx, surface(0.014, 0.005), z), charcoal))

louver_band("grille_upper", PLINTH_H + body_h * 0.74, body_h * 0.30)
louver_band("grille_lower", PLINTH_H + body_h * 0.30, body_h * 0.34, slat_count=10)

# 후면: 냉매 배관 2본 + 전원 박스 + 통신 포트
rear = DEPTH / 2
parts.append(cylinder("refrigerant_in", 0.026, 0.070,
                      (gx - 0.10, rear - 0.020, PLINTH_H + body_h * 0.72), copper, axis="Y"))
parts.append(cylinder("refrigerant_out", 0.026, 0.070,
                      (gx - 0.10, rear - 0.020, PLINTH_H + body_h * 0.62), copper, axis="Y"))
parts.append(box("power_box", (0.16, 0.075, 0.20),
                 (gx - 0.02, rear - 0.030, PLINTH_H + body_h * 0.45), charcoal))

for part in parts:
    if part.name.startswith("status_led"):
        continue
    bevel_all(part)

stats = report(
    "precision-ac", limit=1.25,
    limit_reason="STULZ CyberAir 3 PRO DX 실측 1200x890mm — 1타일(600mm)로 줄이면 사물함이 된다. "
                 "rack-42u 도 깊이 1.0m 로 이미 타일을 넘는다.",
)

out = sys.argv[sys.argv.index("--") + 1]
os.makedirs(os.path.dirname(out), exist_ok=True)
export_glb(out)
print(f"[precision-ac] wrote {out} ({os.path.getsize(out):,} bytes)")
if stats["problems"]:
    sys.exit(1)

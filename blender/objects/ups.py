"""UPS 무정전 전원 공급 장치 (FMS type: UPS).

레퍼런스: `artifacts/reference/fms-object-3d-guide.jpg` 의 "UPS" — 도어를 연 캐비닛으로
그려져 있어 내부 배터리 셀이 보인다. 사양: 같은 폴더 엑셀 시트1
(BaseColor #22252A Dark Charcoal, Metallic 0.8, Roughness 0.3).

⚠️ **도어는 닫아서 만든다.** 레퍼런스가 도어를 연 것은 내부 구조를 설명하려는 그림이고,
   관제 화면에서 모든 UPS 의 문이 열려 있으면 "점검 중"으로 읽힌다. 여닫이 데이터도 없다.

⚠️ LCD 숫자·LED 상태색은 넣지 않는다 — FMS 가 이 오브젝트의 텔레메트리를 주지 않는다.
   (근거는 `precision_ac.py` 상단과 `docs/layout-object-modeling-plan.md` §7-2)

실측 치수는 아직 없다(회사 자료 대기). 일반적인 중형 타워 UPS 근사치로 두고,
치수가 오면 아래 3줄만 고친다.

실행:
  Blender --background --factory-startup --python blender/objects/ups.py \
    -- public/models/objects/ups.glb
"""

import os
import sys

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
from _common import (  # noqa: E402
    bevel_all, box, cylinder, export_glb, material, report, reset_scene, srgb,
)

WIDTH, DEPTH, HEIGHT = 0.60, 0.85, 1.80   # ← 실측 도착 시 여기만 교체
PLINTH_H = 0.08
TOP_H = 0.025
FRONT = -DEPTH / 2


def surface(thickness, protrude, on=0.0):
    """정면(-Y)에 붙는 부품의 y 중심. 상세는 `precision_ac.py` 의 같은 함수."""
    assert protrude <= thickness, "돌출이 두께보다 크면 본체에서 떨어져 뜬다"
    return FRONT - on - protrude + thickness / 2


reset_scene()

shell = material("ups_shell", srgb("#22252A"), metallic=0.80, roughness=0.30)
panel = material("ups_panel", srgb("#31363D"), metallic=0.75, roughness=0.35)
glass = material("ups_lcd_glass", srgb("#0E1114"), metallic=0.10, roughness=0.10)
lens = material("ups_led_lens", srgb("#8A9199"), metallic=0.15, roughness=0.40)
trim = material("ups_trim", srgb("#9AA2AA"), metallic=0.85, roughness=0.30)

parts = []
body_h = HEIGHT - PLINTH_H - TOP_H
body_z = PLINTH_H + body_h / 2

parts.append(box("plinth", (WIDTH - 0.02, DEPTH - 0.02, PLINTH_H), (0, 0, PLINTH_H / 2), panel))
parts.append(box("body", (WIDTH, DEPTH, body_h), (0, 0, body_z), shell))
parts.append(box("top_cap", (WIDTH, DEPTH, TOP_H), (0, 0, HEIGHT - TOP_H / 2), shell))

# --- 전면 도어 (닫힘) — 얕게 돌출시켜 분할선을 만든다 ---
door_h = body_h - 0.06
door_z = PLINTH_H + 0.03 + door_h / 2
parts.append(box("door", (WIDTH - 0.05, 0.018, door_h), (0, surface(0.018, 0.012), door_z), shell))

# 세로 손잡이 (우측)
parts.append(box("door_handle", (0.024, 0.028, 0.34),
                 (WIDTH / 2 - 0.055, surface(0.028, 0.024, on=0.012), door_z + body_h * 0.05), trim))

# 힌지 (좌측 상하)
for i, hz in enumerate((door_z + door_h * 0.40, door_z - door_h * 0.40)):
    parts.append(box(f"hinge_{i}", (0.030, 0.022, 0.055),
                     (-WIDTH / 2 + 0.040, surface(0.022, 0.016, on=0.012), hz), trim))

# --- 상단 제어 패널: LCD + LED 컬럼 (레퍼런스의 "LCD / LED Lights") ---
panel_z = PLINTH_H + body_h * 0.86
parts.append(box("control_bezel", (WIDTH - 0.14, 0.020, 0.20),
                 (0, surface(0.020, 0.014, on=0.012), panel_z), panel))
parts.append(box("lcd_glass", (0.20, 0.010, 0.115),
                 (-0.075, surface(0.010, 0.006, on=0.026), panel_z), glass))

# LED 컬럼 — 발광 없음(위 주의). 렌즈 형상만 세로 6개.
for i in range(6):
    parts.append(cylinder(f"led_{i}", 0.0065, 0.006,
                          (0.115, surface(0.006, 0.005, on=0.026), panel_z + 0.075 - i * 0.028),
                          lens, segments=10, axis="Y"))

# 조작 버튼 4개
for i in range(4):
    parts.append(box(f"button_{i}", (0.026, 0.012, 0.018),
                     (0.175, surface(0.012, 0.008, on=0.026), panel_z + 0.055 - i * 0.032), trim))

# --- 하부 통풍 그릴 ---
for i in range(7):
    parts.append(box(f"vent_{i:02d}", (WIDTH - 0.20, 0.012, 0.010),
                     (0, surface(0.012, 0.005, on=0.012), PLINTH_H + 0.06 + i * 0.026), panel))

for part in parts:
    if part.name.startswith("led_"):
        continue
    bevel_all(part)

stats = report(
    "ups", limit=0.90,
    limit_reason="폭 0.6m 는 타일 한 칸(600mm) 정확히 그 크기고, 깊이 0.85m 는 1.4칸이다. "
                 "rack-42u 가 이미 깊이 1.0m 로 1.67칸을 쓴다 — 랙 옆에 서는 장비라 같은 기준을 쓴다.",
)

out = sys.argv[sys.argv.index("--") + 1]
os.makedirs(os.path.dirname(out), exist_ok=True)
export_glb(out)
print(f"[ups] wrote {out} ({os.path.getsize(out):,} bytes)")
if stats["problems"]:
    sys.exit(1)

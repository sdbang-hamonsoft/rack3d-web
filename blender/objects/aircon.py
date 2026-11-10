"""에어컨 (제안 타입 AIRCON) — 사용자 제공 도면 DC-AC-1200.

출처: `artifacts/reference/precision-ac-dc-ac-1200-sheet.png`
("FMS 3D DATA CENTER PRECISION AIR CONDITIONER UNIT", 2026-11-10).
규격 표의 **W 1050 × D 495 × H 1880 mm** 를 외곽으로 쓴다. 돌출부(손잡이·그릴·팬 가드)도
전부 이 외곽 안에 넣었다 — 외곽 치수가 곧 도면 치수다.

기존 항온항습기(`CRAC` → `precision_ac.py`, STULZ 1200×890×1980)를 **대체하지 않는다.**
별개 종류이고 FMS 레이아웃 팔레트에 아직 없다(BATTERY·SUPPRESSION 과 같은 제안 타입).

정면은 Blender -Y / glTF +Z, 원점은 바닥 중앙(z=0 이 바닥).

도면에서 가져온 것 (정면·평면·측면도):
  - 정면: 좌우 기둥 프레임, 상단 어두운 그릴 밴드, 그 아래 전면 점검 도어.
    도어 위쪽에 CONTROL DISPLAY(정면도·아이소 모두 가운데), 그 아래 밝은 루버,
    하부 절반은 어두운 홈의 가로 루버 그릴(GRILLE) + 루버를 받치는 세로 리브 3줄.
  - 상부: 배기팬 3개(정사각 하우징 + 원형 팬 가드), 우측 후방 케이블·배관 인입부.
  - 측면: 상단 밴드 높이의 분할선, 하부 흡기/필터 점검 그릴(세로 4칸).
뺀 것:
  - 아이소메트릭의 내부(냉각 코일·블로어·컴프레서·필터·배관)와 평면도 아래 그림
    (블로어 2개·컨트롤 모듈)은 구조 설명이다. 닫힌 외형만 만든다.
  - 디스플레이 값·LED 발광·팬 회전: FMS 가 이 장비의 상태를 주지 않는다(§7-2 와 같은 이유).
  - 정면 로고: 제조사 표기를 지어내지 않는다.
  - 후면은 도면에 없다. 분할 패널과 체결 나사만 둔다(옛 CRAC 의 후면 배관은 이 도면에선 상부 인입이다).

실행:
  Blender -b --python-exit-code 1 --python blender/objects/aircon.py \
    -- public/models/objects/aircon.glb
"""
import math
import os
import sys

import bpy
from mathutils import Matrix, Vector

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
from _common import (  # noqa: E402
    bevel_all, box, cylinder, export_glb, material, report, reset_scene, srgb,
)

WIDTH, DEPTH, HEIGHT = 1.05, 0.495, 1.88
FRONT = -DEPTH / 2          # Blender -Y 가 정면. "앞으로 나온다" = y 가 작아진다.
POST = 0.045                # 네 모서리 기둥(도면 정면의 좌우 세로 띠)
BODY_TOP = 1.85             # 본체 상단. 그 위 22mm 상판, 다시 그 위 팬 가드가 1.88 까지
CAP_TOP = 1.872
BODY_FRONT = FRONT + 0.010  # 본체 정면은 기둥보다 10mm 들어가 있다 — 도어·그릴이 그 10mm 안에 들어간다
DOOR_FRONT = BODY_FRONT - 0.006

reset_scene()

# 도면은 청사진 톤이라 색은 기존 §7 값 범위에서 고른다. 밝은 본체는 §10-4 에서
# metallic 0.8 이 씬 노출에 하얗게 날아간다는 관찰이 있어 한 단계 낮췄다.
shell = material('aircon_shell', srgb('#D9DDE0'), 0.70, 0.35)
charcoal = material('aircon_charcoal', srgb('#2A2E33'), 0.80, 0.35)
recess = material('aircon_recess', srgb('#0E1114'), 0.10, 0.60)
glass = material('aircon_display_glass', srgb('#0E1114'), 0.10, 0.10)
metal = material('aircon_metal', srgb('#9AA2AA'), 0.85, 0.30)

parts = []
fine = []                   # 슬랫·가드처럼 가늘어 베벨을 걸지 않는 부품


def block(name, size, center, mat=shell, bevel=True):
    obj = box(name, size, center, mat)
    (parts if bevel else fine).append(obj)
    return obj


def disc(name, radius, depth, center, mat, segments=24, axis='Z'):
    obj = cylinder(name, radius, depth, center, mat, segments=segments, axis=axis)
    fine.append(obj)
    return obj


def front_y(thickness, on):
    """정면에 붙는 판의 y 중심. on = 올라앉은 면의 y (그 면 앞으로 thickness 만큼 나온다)."""
    return on - thickness / 2


# ---------------------------------------------------------------- 몸체
block('plinth', (WIDTH - 2 * POST, DEPTH - 0.04, 0.06), (0, 0.0, 0.03), charcoal)
block('body', (WIDTH - 0.01, DEPTH - 0.02, BODY_TOP - 0.06), (0, 0, 0.06 + (BODY_TOP - 0.06) / 2))
block('top_cap', (WIDTH, DEPTH, CAP_TOP - BODY_TOP), (0, 0, (BODY_TOP + CAP_TOP) / 2))
for sx in (-1, 1):
    for sy in (-1, 1):
        block('corner_post', (POST, POST, BODY_TOP),
              (sx * (WIDTH - POST) / 2, sy * (DEPTH - POST) / 2, BODY_TOP / 2), charcoal)

INNER = WIDTH - 2 * POST - 0.010    # 기둥 사이 정면 폭 0.95

# ---------------------------------------------------------------- 정면 상단 그릴 밴드 (고정)
band_z0, band_z1 = 1.585, 1.835
block('top_band_well', (INNER, 0.002, band_z1 - band_z0),
      (0, front_y(0.002, BODY_FRONT), (band_z0 + band_z1) / 2), recess, bevel=False)
for i in range(7):
    pitch = (band_z1 - band_z0) / 7
    block('top_band_louver', (INNER - 0.02, 0.006, pitch * 0.55),
          (0, front_y(0.006, BODY_FRONT - 0.002), band_z0 + pitch * (i + 0.5)), charcoal, bevel=False)
block('band_rail', (INNER, 0.004, 0.012), (0, front_y(0.004, BODY_FRONT), 1.570), charcoal, bevel=False)

# ---------------------------------------------------------------- 전면 점검 도어
door_z0, door_z1 = 0.07, 1.56
door_w = INNER - 0.012
block('door_reveal', (INNER, 0.002, door_z1 - door_z0 + 0.008),
      (0, front_y(0.002, BODY_FRONT), (door_z0 + door_z1) / 2), recess, bevel=False)
block('front_door', (door_w, 0.004, door_z1 - door_z0),
      (0, front_y(0.004, BODY_FRONT - 0.002), (door_z0 + door_z1) / 2))

LOUVER_W = 0.82             # 왼쪽 손잡이·오른쪽 힌지 자리를 남긴다


def louver_bank(name, z0, z1, count, slat_ratio, slat_mat, well_mat, ribs=()):
    """홈(well) 위에 가로 슬랫. slat_ratio 가 클수록 밝은 면이 넓고 틈이 가늘다."""
    block(f'{name}_well', (LOUVER_W + 0.02, 0.001, z1 - z0),
          (0, front_y(0.001, DOOR_FRONT), (z0 + z1) / 2), well_mat, bevel=False)
    for x in ribs:            # 슬랫 틈으로 점처럼 보이는 세로 리브(도면 하부 그릴의 점 3줄)
        block(f'{name}_rib', (0.012, 0.001, z1 - z0),
              (x, front_y(0.001, DOOR_FRONT - 0.001), (z0 + z1) / 2), charcoal, bevel=False)
    pitch = (z1 - z0) / count
    for i in range(count):
        block(f'{name}_slat', (LOUVER_W, 0.002, pitch * slat_ratio),
              (0, front_y(0.002, DOOR_FRONT - 0.002), z0 + pitch * (i + 0.5)), slat_mat, bevel=False)


# 하부 GRILLE: 어두운 홈이 굵게 보인다. 위쪽 도어 루버: 밝은 면에 가는 줄.
louver_bank('grille', 0.10, 0.92, 13, 0.52, shell, recess, ribs=(-0.255, 0.0, 0.255))
louver_bank('door_louver', 0.97, 1.35, 8, 0.80, shell, charcoal)

# CONTROL DISPLAY — 꺼진 유리. 값·발광 없음.
disp_z = 1.465
block('display_bezel', (0.24, 0.003, 0.11), (0, front_y(0.003, DOOR_FRONT), disp_z), charcoal)
block('display_glass', (0.20, 0.001, 0.055), (0, front_y(0.001, DOOR_FRONT - 0.003), disp_z + 0.017),
      glass, bevel=False)
for i in range(5):
    block('display_button', (0.018, 0.001, 0.010),
          (-0.06 + i * 0.03, front_y(0.001, DOOR_FRONT - 0.003), disp_z - 0.032), metal, bevel=False)

# 손잡이(좌) · 힌지(우)
block('handle_recess', (0.030, 0.001, 0.22), (-0.448, front_y(0.001, DOOR_FRONT), 0.945), recess, bevel=False)
block('handle', (0.014, 0.003, 0.17), (-0.448, front_y(0.003, DOOR_FRONT - 0.001), 0.945), metal)
for z in (0.30, 1.34):
    block('hinge', (0.012, 0.004, 0.07), (0.468, front_y(0.004, DOOR_FRONT), z), metal, bevel=False)

# ---------------------------------------------------------------- 측면 (양쪽 동일)
SIDE = (WIDTH - 0.01) / 2   # 본체 측면 x = 0.520. 기둥 바깥면 0.525 까지 5mm 안에 붙인다.
side_w = DEPTH - 2 * POST - 0.005
for sign in (-1, 1):
    def sx(t, on):
        return sign * (on + t / 2)
    block('side_seam', (0.001, side_w + 0.01, BODY_TOP - 0.075),
          (sx(0.001, SIDE), 0, 0.065 + (BODY_TOP - 0.075) / 2), recess, bevel=False)
    for z0, z1 in ((0.07, 1.555), (1.585, 1.835)):   # 도면 측면도의 상단 분할선
        block('side_panel', (0.002, side_w, z1 - z0), (sx(0.002, SIDE + 0.001), 0, (z0 + z1) / 2))
    # AIR INTAKE / FILTER ACCESS — 세로 4칸. 슬랫은 통으로 깔고 세로 바를 위에 얹는다.
    g_z0, g_z1, g_w = 0.09, 0.61, 0.37
    block('intake_well', (0.001, g_w, g_z1 - g_z0), (sx(0.001, SIDE + 0.003), 0, (g_z0 + g_z1) / 2),
          recess, bevel=False)
    pitch = (g_z1 - g_z0) / 16
    for j in range(16):
        block('intake_louver', (0.001, g_w - 0.01, pitch * 0.5),
              (sx(0.001, SIDE + 0.0035), 0, g_z0 + pitch * (j + 0.5)), shell, bevel=False)
    for k in range(5):
        block('intake_mullion', (0.001, 0.012, g_z1 - g_z0),
              (sx(0.001, SIDE + 0.004), -g_w / 2 + 0.006 + k * (g_w - 0.012) / 4, (g_z0 + g_z1) / 2),
              charcoal, bevel=False)
    for y in (-0.17, 0.17):
        for z in (0.66, 1.52, 1.80):   # 하부 그릴 위·패널 분할 위아래
            disc('panel_fastener', 0.006, 0.001, (sx(0.001, SIDE + 0.003), y, z), metal, 8, 'X')

# ---------------------------------------------------------------- 후면 (도면에 없음 — 분할 패널만)
REAR = DEPTH / 2 - 0.010
for z0, z1 in ((0.07, 1.555), (1.585, 1.835)):
    block('rear_panel', (INNER - 0.01, 0.002, z1 - z0), (0, REAR + 0.001, (z0 + z1) / 2))
    for x in (-0.44, 0.44):
        for z in (z0 + 0.03, z1 - 0.03):
            disc('rear_fastener', 0.006, 0.001, (x, REAR + 0.0025, z), metal, 8, 'Y')

# ---------------------------------------------------------------- 상부 배기팬 3개 (정지 상태)
FAN_Y = FRONT + 0.21        # 평면도: 팬 열 중심이 앞쪽에서 약 210mm
for fx in (-0.28, 0.0, 0.28):
    block('fan_housing', (0.27, 0.27, 0.003), (fx, FAN_Y, CAP_TOP + 0.0015), charcoal, bevel=False)
    disc('fan_aperture', 0.118, 0.002, (fx, FAN_Y, CAP_TOP + 0.004), recess, 28)
    disc('fan_hub', 0.030, 0.006, (fx, FAN_Y, HEIGHT - 0.003), metal, 16)
    for radius in (0.05, 0.08, 0.110):
        bpy.ops.mesh.primitive_torus_add(major_radius=radius, minor_radius=0.0018,
                                         major_segments=20, minor_segments=3,
                                         location=(fx, FAN_Y, HEIGHT - 0.0022))
        ring = bpy.context.object
        ring.name = 'fan_guard_ring'
        ring.data.materials.append(metal)
        fine.append(ring)
    for angle in (0, math.pi / 4, math.pi / 2, 3 * math.pi / 4):
        spoke = block('fan_guard_spoke', (0.232, 0.004, 0.003), (fx, FAN_Y, HEIGHT - 0.0025), metal, bevel=False)
        # box() 는 중심을 정점에 구워 넣으므로 팬 중심을 축으로 정점을 돌린다(ups.py 와 같다).
        pivot = Vector((fx, FAN_Y, HEIGHT - 0.0025))
        for v in spoke.data.vertices:
            v.co = pivot + Matrix.Rotation(angle, 3, 'Z') @ (v.co - pivot)

# CABLE & PIPE ENTRY — 평면도 우측 후방. 배관 칼라는 1.88 을 넘지 않는 낮은 링으로만.
entry = (0.375, DEPTH / 2 - 0.085)
block('cable_entry_plate', (0.15, 0.09, 0.003), (entry[0], entry[1], CAP_TOP + 0.0015), recess, bevel=False)
for dx in (-0.045, 0.0, 0.045):
    disc('pipe_collar', 0.016, 0.006, (entry[0] + dx, entry[1], CAP_TOP + 0.0045), metal, 12)
    disc('pipe_bore', 0.010, 0.0004, (entry[0] + dx, entry[1], HEIGHT - 0.0003), recess, 12)

# 베벨은 재질 병합 **전에** 적용한다 — 병합 후 적용하면 활성 메시의 모디파이어가
# 같은 재질의 가는 슬랫까지 먹어 폴리곤이 불어난다(§12, ups.py).
for part in parts:
    bevel_all(part, width=0.0015, segments=1)
    bpy.context.view_layer.objects.active = part
    for modifier in list(part.modifiers):
        bpy.ops.object.modifier_apply(modifier=modifier.name)
bpy.context.view_layer.update()

stats = report(
    'aircon', limit=1.06,
    limit_reason='도면 DC-AC-1200 1050×495mm — 600mm 타일 폭 1.75칸. 축소하면 2m 랙 옆에서 비율이 무너진다.',
)
out = sys.argv[sys.argv.index('--') + 1]
os.makedirs(os.path.dirname(out), exist_ok=True)
export_glb(out)
print(f'[aircon] wrote {out} ({os.path.getsize(out):,} bytes)')
if stats['problems']:
    sys.exit(1)

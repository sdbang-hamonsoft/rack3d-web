"""배치 미리보기 — 만든 모델들을 **실제 씬 규격의 타일 격자** 위에 랙과 함께 세워 본다.

프리뷰 1개짜리 렌더는 "이게 무엇처럼 생겼나"만 답한다. 이 스크립트는 다른 질문에 답한다:
**랙 옆에 세웠을 때 크기가 맞나, 타일을 넘긴 모델이 이웃을 침범하나.**

씬 규격(`src/App.tsx`·`rackLayouts.ts`):
  - 타일 600mm (`grid.tileSize`, 기본값 0.6)
  - 오브젝트는 정확히 1타일 점유. 좌표는 (열, 행) 정수
  - 벽·천장이 없다. 부감이 기본 시점이다

실행:
  Blender --background --factory-startup --python blender/objects/_scene_preview.py -- <출력.png>
"""

import math
import os
import sys

import bpy
from mathutils import Vector

TILE = 0.6
ROOT = os.path.dirname(os.path.dirname(os.path.dirname(os.path.abspath(__file__))))

# (glb 경로, 타일 열, 타일 행, Y축 회전(도), 바닥 보정)
# 바닥 보정: rack-42u 는 원점이 **중심**이라 +1.0 올려야 바닥에 선다(실측 floorY=-1.0).
PLACEMENTS = [
    ("public/models/rack-42u.glb",                 1, 0, 0, 1.0),
    ("public/models/rack-42u.glb",                 2, 0, 0, 1.0),
    ("public/models/rack-42u.glb",                 3, 0, 0, 1.0),
    ("public/models/rack-42u.glb",                 4, 0, 0, 1.0),
    ("public/models/objects/precision-ac.glb",     1, 3, 0, 0.0),
    ("public/models/objects/ups.glb",              3, 3, 0, 0.0),
    ("public/models/objects/battery-rack.glb",     4, 3, 0, 0.0),
    ("public/models/objects/gas-suppression.glb",  6, 3, 0, 0.0),
]

GRID_COLS, GRID_ROWS = 8, 5

bpy.ops.wm.read_factory_settings(use_empty=True)

# --- 바닥 타일 격자 ---
tile_mat = bpy.data.materials.new("floor_tile")
tile_mat.use_nodes = True
tile_bsdf = tile_mat.node_tree.nodes["Principled BSDF"]
tile_bsdf.inputs["Base Color"].default_value = (0.055, 0.062, 0.072, 1)
tile_bsdf.inputs["Roughness"].default_value = 0.65

for col in range(GRID_COLS):
    for row in range(GRID_ROWS):
        bpy.ops.mesh.primitive_cube_add(size=1.0, location=(col * TILE, row * TILE, -0.02))
        tile = bpy.context.active_object
        tile.scale = (TILE * 0.97, TILE * 0.97, 0.04)
        tile.data.materials.append(tile_mat)

# --- 모델 배치 ---
for path, col, row, yaw, lift in PLACEMENTS:
    before = set(bpy.context.scene.objects)
    bpy.ops.import_scene.gltf(filepath=os.path.join(ROOT, path))
    imported = [o for o in bpy.context.scene.objects if o not in before]
    for obj in imported:
        if obj.parent is None:
            obj.location = (col * TILE, row * TILE, lift)
            obj.rotation_euler = (obj.rotation_euler[0], obj.rotation_euler[1],
                                  obj.rotation_euler[2] + math.radians(yaw))
    bpy.context.view_layer.update()
    lo = Vector((1e9, 1e9, 1e9))
    hi = Vector((-1e9, -1e9, -1e9))
    for obj in imported:
        if obj.type != "MESH":
            continue
        for corner in obj.bound_box:
            world = obj.matrix_world @ Vector(corner)
            lo = Vector(map(min, lo, world))
            hi = Vector(map(max, hi, world))
    tiles_x = (hi.x - lo.x) / TILE
    tiles_y = (hi.y - lo.y) / TILE
    print(f"[scene] {os.path.basename(path):26} tile({col},{row}) "
          f"x[{lo.x:+.2f},{hi.x:+.2f}] y[{lo.y:+.2f},{hi.y:+.2f}] z[{lo.z:+.2f},{hi.z:+.2f}] "
          f"= {tiles_x:.2f}x{tiles_y:.2f} 타일")

# --- 조명 ---
center = Vector((GRID_COLS * TILE / 2, GRID_ROWS * TILE / 2, 0.9))


def add_light(name, energy, location, size):
    data = bpy.data.lights.new(name, "AREA")
    data.energy = energy
    data.size = size
    obj = bpy.data.objects.new(name, data)
    obj.location = location
    bpy.context.collection.objects.link(obj)
    obj.rotation_euler = (center - Vector(location)).normalized().to_track_quat("-Z", "Y").to_euler()


add_light("key", 7000, (center.x - 5.0, center.y - 7.0, 7.0), 8.0)
add_light("fill", 2200, (center.x + 7.0, center.y - 3.0, 4.0), 8.0)
add_light("rim", 3000, (center.x + 1.0, center.y + 8.0, 5.5), 6.0)

world = bpy.data.worlds.new("scene_world")
world.use_nodes = True
world.node_tree.nodes["Background"].inputs["Color"].default_value = (0.03, 0.035, 0.045, 1)
bpy.context.scene.world = world

# --- 카메라: 씬 진입 기본 시점과 비슷한 부감 ---
cam_data = bpy.data.cameras.new("cam")
cam_data.lens = 40
cam = bpy.data.objects.new("cam", cam_data)
bpy.context.collection.objects.link(cam)
bpy.context.scene.camera = cam
cam.location = (center.x + 3.4, center.y - 8.6, 5.6)
cam.rotation_euler = (center - Vector(cam.location)).to_track_quat("-Z", "Y").to_euler()

scene = bpy.context.scene
scene.render.engine = "BLENDER_EEVEE"
scene.render.resolution_x = 1400
scene.render.resolution_y = 900
scene.view_settings.view_transform = "AgX"
out = sys.argv[sys.argv.index("--") + 1]
scene.render.filepath = out
os.makedirs(os.path.dirname(out), exist_ok=True)
bpy.ops.render.render(write_still=True)
print(f"[scene] wrote {out}")

"""GLB 를 불러와 3면 프리뷰 PNG 를 렌더한다 (검수용, 배포 대상 아님).

**익스포트한 파일을 다시 읽어서 렌더한다** — 씬 메모리를 렌더하면 익스포터가 떨어뜨린
재질·모디파이어 문제를 못 잡는다. 실제로 배포되는 바이트를 본다.

실행:
  Blender --background --factory-startup --python blender/objects/_preview.py \
    -- <입력.glb> <출력.png>
"""

import math
import os
import sys

import bpy
from mathutils import Vector

argv = sys.argv[sys.argv.index("--") + 1:]
glb_path, out_path = argv[0], argv[1]
# 3번째 인자: 카메라 방위각(도). 0 = 정면(-Y) 정투상에 가까운 뷰. 기본 38 = 3/4 부감.
angle_deg = float(argv[2]) if len(argv) > 2 else 38.0
elev_deg = float(argv[3]) if len(argv) > 3 else 22.0

bpy.ops.wm.read_factory_settings(use_empty=True)
bpy.ops.import_scene.gltf(filepath=glb_path)

# --- 대상 크기 파악 ---
lo = Vector((1e9, 1e9, 1e9))
hi = Vector((-1e9, -1e9, -1e9))
for obj in bpy.context.scene.objects:
    if obj.type != "MESH":
        continue
    for corner in obj.bound_box:
        world = obj.matrix_world @ Vector(corner)
        lo = Vector(map(min, lo, world))
        hi = Vector(map(max, hi, world))
center = (lo + hi) / 2
span = max(hi - lo)

# --- 바닥 (그림자 받이) ---
bpy.ops.mesh.primitive_plane_add(size=span * 8, location=(center.x, center.y, lo.z))
floor_mat = bpy.data.materials.new("preview_floor")
floor_mat.use_nodes = True
floor_mat.node_tree.nodes["Principled BSDF"].inputs["Base Color"].default_value = (0.16, 0.17, 0.19, 1)
floor_mat.node_tree.nodes["Principled BSDF"].inputs["Roughness"].default_value = 0.85
bpy.context.active_object.data.materials.append(floor_mat)

# --- 조명: 키 + 필 + 림 ---
def add_light(name, kind, energy, location, size=2.0):
    data = bpy.data.lights.new(name, kind)
    data.energy = energy
    if kind == "AREA":
        data.size = size
    obj = bpy.data.objects.new(name, data)
    obj.location = location
    bpy.context.collection.objects.link(obj)
    direction = (center - Vector(location)).normalized()
    obj.rotation_euler = direction.to_track_quat("-Z", "Y").to_euler()
    return obj

add_light("key", "AREA", 260, (center.x - span * 1.4, center.y - span * 1.6, center.z + span * 1.7), size=span * 2)
add_light("fill", "AREA", 80, (center.x + span * 1.8, center.y - span * 0.8, center.z + span * 0.6), size=span * 2)
add_light("rim", "AREA", 130, (center.x + span * 0.6, center.y + span * 1.9, center.z + span * 1.3), size=span * 1.5)

world = bpy.data.worlds.new("preview_world")
world.use_nodes = True
world.node_tree.nodes["Background"].inputs["Color"].default_value = (0.045, 0.05, 0.06, 1)
bpy.context.scene.world = world

# --- 카메라: 3/4 부감 (씬의 기본 시점과 비슷하게) ---
cam_data = bpy.data.cameras.new("preview_cam")
cam_data.lens = 60
cam = bpy.data.objects.new("preview_cam", cam_data)
bpy.context.collection.objects.link(cam)
bpy.context.scene.camera = cam

angle = math.radians(angle_deg)   # 정면(-Y)에서 우측으로 돌린 각
elevation = math.radians(elev_deg)
distance = span * 2.6
cam.location = (
    center.x + distance * math.sin(angle) * math.cos(elevation),
    center.y - distance * math.cos(angle) * math.cos(elevation),
    center.z + distance * math.sin(elevation),
)
cam.rotation_euler = (center - cam.location).to_track_quat("-Z", "Y").to_euler()

scene = bpy.context.scene
scene.render.engine = "BLENDER_EEVEE"
scene.render.resolution_x = 900
scene.render.resolution_y = 1100
scene.render.film_transparent = False
scene.render.filepath = out_path
scene.view_settings.view_transform = "AgX"
os.makedirs(os.path.dirname(out_path), exist_ok=True)
bpy.ops.render.render(write_still=True)
print(f"[preview] wrote {out_path}")

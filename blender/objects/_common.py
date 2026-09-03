"""배치 오브젝트 모델링 공통 유틸 (headless Blender).

왜 headless 스크립트인가:
  기존 `blender/cisco-ucs-c240-m7.blend` 는 Blender MCP(애드온 GUI)로 만들었다. 그 방식은
  Blender 창이 떠 있어야 하고 결과가 .blend 바이너리로만 남아 diff 도 재생성도 안 된다.
  맥미니에는 GUI 세션이 없다. 스크립트로 만들면 git 에 남고, 치수 한 줄 고쳐 다시 뽑는다.

규약 (지키지 않으면 씬에서 어긋난다):
  - 단위: 미터. 원점 = 바닥면 중심(y=0 이 바닥).
  - 축: Blender 는 Z-up 이고 glTF 익스포터가 Y-up 으로 변환한다. **정면은 Blender -Y**
    → glTF +Z. `LayoutObjectMesh` 가 로컬 +Z 를 정면으로 두고 `dir` 로 회전시킨다.
  - 풋프린트: 가로·세로 0.5m 이내. 기본 타일 600mm 의 `tileSize*0.84 = 0.504m` 에 들어가야 한다.
  - 텍스처 이미지 금지. 재질 분할(base color + metallic + roughness)로만 낸다.
"""

import bpy
import bmesh
from mathutils import Vector

# 기본 타일 600mm 의 `tileSize*0.84 = 0.504m`. 이 안에 들어가면 이웃 타일을 절대 안 침범한다.
FOOTPRINT_LIMIT = 0.5

# 타일을 넘겨도 되는 경우가 있다 — **이미 그렇게 하고 있다.**
# `rack-42u.glb` 실측이 0.600(W) x 2.000(H) x 1.000(D) 다. 깊이 1.0m 는 600mm 타일의 1.67배로,
# 랙은 진작부터 앞뒤 타일을 넘어 서 있다. 실물 비율을 지키는 쪽이 옳다고 이미 판단한 것이다.
# 그래서 `report(limit=...)` 로 종별 상한을 올릴 수 있게 두되, **근거를 함께 적게 한다.**


def reset_scene():
    bpy.ops.wm.read_factory_settings(use_empty=True)


def srgb(hex_color):
    """`#RRGGBB` → Blender/glTF 가 쓰는 **선형** RGB.

    사양서(엑셀·레퍼런스 시트)의 색은 전부 sRGB 16진수다. 그 값을 base color 에 그대로 넣으면
    실제보다 밝게 나온다 — 예: #E2E6E8 을 그대로 0.886 으로 넣으면 선형 0.760 이어야 할 것이
    0.886 이 된다. 배터리 랙 1차본이 사양보다 밝게 나온 원인이 이것이다.
    """
    text = hex_color.lstrip("#")
    out = []
    for i in (0, 2, 4):
        channel = int(text[i:i + 2], 16) / 255.0
        out.append(channel / 12.92 if channel <= 0.04045
                   else ((channel + 0.055) / 1.055) ** 2.4)
    return tuple(out)


def material(name, color, metallic, roughness, emission=None, emission_strength=0.0):
    mat = bpy.data.materials.new(name)
    mat.use_nodes = True
    bsdf = mat.node_tree.nodes["Principled BSDF"]
    bsdf.inputs["Base Color"].default_value = (*color, 1.0)
    bsdf.inputs["Metallic"].default_value = metallic
    bsdf.inputs["Roughness"].default_value = roughness
    if emission is not None:
        bsdf.inputs["Emission Color"].default_value = (*emission, 1.0)
        bsdf.inputs["Emission Strength"].default_value = emission_strength
    return mat


def box(name, size, center, mat):
    """축정렬 박스. size/center 는 (x, y, z) 미터, z 는 바닥 기준 높이."""
    sx, sy, sz = size
    cx, cy, cz = center
    mesh = bpy.data.meshes.new(name)
    obj = bpy.data.objects.new(name, mesh)
    bpy.context.collection.objects.link(obj)
    bm = bmesh.new()
    bmesh.ops.create_cube(bm, size=1.0)
    bmesh.ops.scale(bm, vec=Vector((sx, sy, sz)), verts=bm.verts)
    bmesh.ops.translate(bm, vec=Vector((cx, cy, cz)), verts=bm.verts)
    bm.to_mesh(mesh)
    bm.free()
    mesh.materials.append(mat)
    return obj


def cylinder(name, radius, height, center, mat, segments=24, axis="Z"):
    mesh = bpy.data.meshes.new(name)
    obj = bpy.data.objects.new(name, mesh)
    bpy.context.collection.objects.link(obj)
    bm = bmesh.new()
    bmesh.ops.create_cone(
        bm, cap_ends=True, cap_tris=False, segments=segments,
        radius1=radius, radius2=radius, depth=height,
    )
    if axis == "Y":
        bmesh.ops.rotate(bm, verts=bm.verts, cent=(0, 0, 0),
                         matrix=__import__("mathutils").Matrix.Rotation(1.5707963, 3, "X"))
    elif axis == "X":
        bmesh.ops.rotate(bm, verts=bm.verts, cent=(0, 0, 0),
                         matrix=__import__("mathutils").Matrix.Rotation(1.5707963, 3, "Y"))
    bmesh.ops.translate(bm, vec=Vector(center), verts=bm.verts)
    bm.to_mesh(mesh)
    bm.free()
    mesh.materials.append(mat)
    return obj


def bevel_all(obj, width=0.002, segments=1):
    """실루엣에 하이라이트가 걸리게 아주 얕은 베벨만. 폴리곤 예산을 지킨다."""
    mod = obj.modifiers.new("bevel", "BEVEL")
    mod.width = width
    mod.segments = segments
    mod.limit_method = "ANGLE"
    mod.angle_limit = 0.5236  # 30°


def join_by_material():
    """재질이 같은 메시를 하나로 합친다.

    합치지 않으면 오브젝트 1개가 프리미티브 60개로 나간다 — GLB 가 5배 커지고
    (배터리 랙 실측 148KB → 30KB), 무엇보다 **드로우콜이 오브젝트 수만큼 곱해진다.**
    ZONE 에 배치 오브젝트가 20개면 1,200 드로우콜이다. 재질별로 합치면 5개로 준다.
    """
    for obj in list(bpy.context.scene.objects):
        if obj.type == "MESH":
            obj.select_set(False)
    groups = {}
    for obj in list(bpy.context.scene.objects):
        if obj.type != "MESH" or not obj.data.materials:
            continue
        groups.setdefault(obj.data.materials[0].name, []).append(obj)

    for name, objs in groups.items():
        if len(objs) < 2:
            continue
        bpy.ops.object.select_all(action="DESELECT")
        for obj in objs:
            obj.select_set(True)
        bpy.context.view_layer.objects.active = objs[0]
        bpy.ops.object.join()
        bpy.context.view_layer.objects.active.name = f"merged_{name}"
    bpy.ops.object.select_all(action="DESELECT")


def report(label, limit=FOOTPRINT_LIMIT, limit_reason=None):
    """익스포트 전 검증 — 규약 위반은 조용히 넘어가면 씬에서야 드러난다.

    limit 을 올릴 때는 limit_reason 을 반드시 적는다. 근거 없이 넘긴 상한은
    다음 사람이 "원래 그런가 보다" 하고 더 넘긴다.
    """
    assert limit <= FOOTPRINT_LIMIT or limit_reason, "풋프린트 상한을 올리려면 근거를 적어라"
    xs, ys, zs = [], [], []
    tris = 0
    for obj in bpy.context.scene.objects:
        if obj.type != "MESH":
            continue
        obj.data.calc_loop_triangles()
        tris += len(obj.data.loop_triangles)
        for corner in obj.bound_box:
            world = obj.matrix_world @ Vector(corner)
            xs.append(world.x); ys.append(world.y); zs.append(world.z)
    width, depth, height = max(xs) - min(xs), max(ys) - min(ys), max(zs) - min(zs)
    print(f"[{label}] tris={tris} w={width:.3f} d={depth:.3f} h={height:.3f} "
          f"floor_z={min(zs):+.4f}")
    problems = []
    if width > limit or depth > limit:
        problems.append(f"풋프린트 초과 ({width:.3f}x{depth:.3f} > {limit})")
    elif limit > FOOTPRINT_LIMIT:
        print(f"[{label}] 타일 초과 허용: {limit}m — {limit_reason}")
    if abs(min(zs)) > 0.002:
        problems.append(f"바닥이 z=0 이 아니다 ({min(zs):+.4f})")
    for problem in problems:
        print(f"[{label}] ⚠️ {problem}")
    return {"tris": tris, "width": width, "depth": depth, "height": height,
            "problems": problems}


def export_glb(path):
    join_by_material()
    bpy.ops.object.select_all(action="SELECT")
    bpy.ops.export_scene.gltf(
        filepath=path,
        export_format="GLB",
        export_yup=True,
        export_apply=True,          # 모디파이어(베벨·어레이) 적용해서 내보낸다
        export_materials="EXPORT",
        export_image_format="NONE", # 이미지 텍스처를 쓰지 않는다는 약속을 익스포터로도 강제
    )

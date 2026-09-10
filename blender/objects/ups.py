"""Standard SD-ups — 사용자 제공 엑셀 ups 시트 도면(800×1000×2000mm).

정면은 Blender -Y / glTF +Z, 원점은 바닥 중앙. 닫힌 도어의 외형을
모델링한다. 도면의 투시 내부·유지보수 공간은 실제 설치 형상에 포함하지 않는다.
LCD와 LED는 수신한 상태가 없으므로 발광/수치 없이 렌즈만 표현한다.
실행: Blender --background --factory-startup --python blender/objects/ups.py
      -- public/models/objects/ups.glb
"""
import math
import os
import sys
import bpy
from mathutils import Matrix, Vector
sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
from _common import box, cylinder, bevel_all, export_glb, material, report, reset_scene, srgb

WIDTH, DEPTH, HEIGHT = 0.8, 1.0, 2.0
reset_scene()
shell = material('ups_shell', srgb('#22252A'), 0.8, 0.3)
panel = material('ups_panel', srgb('#31363D'), 0.8, 0.3)
dark = material('ups_recess', srgb('#0E1114'), 0.1, 0.6)
trim = material('ups_metal', srgb('#9AA2AA'), 0.85, 0.3)
glass = material('ups_lcd_glass', srgb('#19232C'), 0.1, 0.1)
parts = []
def block(name, size, center, mat=shell):
    obj=box(name,size,center,mat); parts.append(obj); return obj

def disc(name,radius,depth,center,mat=dark,axis='Z',segments=24):
    obj=cylinder(name,radius,depth,center,mat,segments=segments,axis=axis)
    return obj

# All front attachments stay inside the specified 1m envelope.
block('plinth',(0.77,0.96,0.08),(0,0,0.04),dark)
block('body',(0.788,0.94,1.89),(0,0.02,1.025))
block('top_cap',(0.8,0.98,0.025),(0,0,1.9775))
block('door_shadow',(0.73,0.02,1.86),(0,-0.456,1.025),dark)
block('front_door',(0.70,0.022,1.84),(0,-0.472,1.025),panel)
for z in (0.33,1.68):
    block('hinge',(0.019,0.018,0.07),(0.36,-0.476,z),trim)
block('handle_recess',(0.04,0.007,0.24),(-0.318,-0.487,1.02),dark)
block('handle',(0.015,0.013,0.17),(-0.318,-0.4935,1.02),trim)
block('display_bezel',(0.34,0.012,0.30),(0,-0.489,1.525),dark)
block('display_trim',(0.285,0.004,0.205),(0,-0.497,1.545),trim)
block('lcd',(0.258,0.002,0.177),(0,-0.499,1.545),glass)
for i in range(4):
    block('control_button',(0.028,0.004,0.022),(-0.085+i*0.056,-0.497,1.407),trim)
for z in (1.23,1.29):
    disc('status_lens',0.009,0.005,(0.09,-0.49,z),glass,'Y',12)
    block('status_legend',(0.06,0.004,0.012),(0.145,-0.488,z),trim)

# Twin upper and lower front grille banks, with raised metal slats over dark wells.
for z,h,count in ((1.82,0.15,7),(0.52,0.54,25)):
    for x in (-0.137,0.137):
        block('front_vent_well',(0.235,0.004,h),(x,-0.485,z),dark)
        for j in range(count):
            block('front_louver',(0.225,0.005,0.006),(x,-0.489,z-h/2+0.01+j*(h-0.02)/(count-1)),panel)

# Removable side panels with three lower intake grilles each.
for sign in (-1,1):
    block('side_seam',(0.002,0.87,1.78),(sign*0.395,0.018,1.035),dark)
    block('side_panel',(0.002,0.85,1.76),(sign*0.397,0.018,1.035),panel)
    for y in (-0.27,0,0.27):
        block('side_vent',(0.001,0.23,0.21),(sign*0.3985,y,0.30),dark)
        for j in range(10):
            block('side_louver',(0.002,0.218,0.005),(sign*0.399,y,0.21+j*0.02),panel)
    for y in (-0.37,0.40):
        for z in (0.17,1.88):
            disc('panel_fastener',0.006,0.002,(sign*0.3985,y,z),trim,'X',8)

# Four stationary roof fans: dark apertures, hubs and concentric safety guards.
# No rotation is implied without operational telemetry.
for x in (-0.19,0.19):
    for y in (0.02,0.32):
        disc('fan_aperture',0.13,0.003,(x,y,1.9915))
        disc('fan_hub',0.029,0.005,(x,y,1.997),trim)
        for radius in (0.045,0.068,0.091,0.116):
            bpy.ops.mesh.primitive_torus_add(major_radius=radius,minor_radius=0.002,
                major_segments=16,minor_segments=4,location=(x,y,1.997))
            bpy.context.object.name='fan_guard'
            bpy.context.object.data.materials.append(trim)
        for angle in (0,math.pi/2):
            obj=block('fan_guard_cross',(0.25,0.005,0.004),(x,y,1.997),panel)
            # box() bakes its center into vertices, so rotate around this fan's center.
            pivot=Vector((x,y,1.997))
            for v in obj.data.vertices:
                v.co=pivot+Matrix.Rotation(angle,3,'Z')@(v.co-pivot)
block('cable_entry',(0.20,0.075,0.003),(0,-0.34,1.998),dark)
block('rear_panel',(0.70,0.004,1.76),(0,0.492,1.02),panel)
for j in range(16):
    block('rear_exhaust',(0.57,0.004,0.012),(0,0.496,1.47+j*0.021),dark)
block('rear_cable_access',(0.52,0.004,0.24),(0,0.496,0.27),dark)
for part in parts:
    if not part.name.startswith(('front_louver', 'side_louver', 'rear_exhaust', 'fan_guard_cross')):
        bevel_all(part,width=0.001,segments=1)
# Bake selected bevels before material merging; otherwise join would apply the
# active object's modifier to every fine grille slat in the material group.
for part in parts:
    bpy.context.view_layer.objects.active = part
    for modifier in list(part.modifiers):
        bpy.ops.object.modifier_apply(modifier=modifier.name)
stats=report('ups',limit=1.01,limit_reason='엑셀 ups 시트 중형 도면 800×1000×2000mm. 600mm 타일보다 넓고 깊다.')
out=sys.argv[sys.argv.index('--')+1]
os.makedirs(os.path.dirname(out),exist_ok=True)
export_glb(out)
print(f'[ups] wrote {out} ({os.path.getsize(out):,} bytes)')
if stats['problems']: sys.exit(1)

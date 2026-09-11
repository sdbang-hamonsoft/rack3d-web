"""Standard SD-CCTV from Google workbook CCTV sheet (2026-09-11).
40mm wide, 150mm overall height, 180mm bracket-inclusive depth.
The drawing mixes unrelated water-sensor details; only camera views are used.
Blender -Y front, metre units, bottom-centred origin. No live/IR emission.
"""
import os
import sys
import bpy
sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
from _common import reset_scene, box, cylinder, bevel_all, report, export_glb
from facilities import palette, tube


def build(path):
    reset_scene(); m=palette()
    body=box('camera_housing',(.038,.077,.052),(0,-.0485,.119),m['white'])
    bevel_all(body,.004,3)
    # 80mm hood, front-to-back. Outer envelope 40mm × 150mm × 180mm.
    roof=box('sunshield_roof',(.04,.08,.004),(0,-.05,.148),m['white'])
    bevel_all(roof,.001,2)
    for x in (-.019,.019):
        box('sunshield_side',(.002,.08,.011),(x,-.05,.1405),m['white'])
    face=box('face_bezel',(.036,.002,.047),(0,-.088,.120),m['dark'])
    bevel_all(face,.003,3)
    cylinder('lens_barrel',.0175,.002,(0,-.089,.123),m['metal'],segments=32,axis='Y')
    cylinder('lens_surround',.0135,.0005,(0,-.09025,.123),m['dark'],segments=32,axis='Y')
    cylinder('optical_glass',.0105,.0003,(0,-.09065,.123),m['lens'],segments=32,axis='Y')
    cylinder('aperture',.005,.0001,(0,-.09085,.123),m['dark'],segments=24,axis='Y')
    # Recessed inactive IR windows, no invented power state.
    for x in (-.010,.010):
        cylinder('ir_window',.002,.0004,(x,-.0892,.104),m['lens'],segments=12,axis='Y')
    plate=box('wall_plate',(.036,.006,.07),(0,.0861,.035),m['white'])
    bevel_all(plate,.003,3)
    for x in (-.012,.012):
        for z in (.009,.061):
            cylinder('fastener',.0025,.001,(x,.0826,z),m['metal'],segments=12,axis='Y')
    tube('support_arm',(0,.082,.035),(0,-.031,.070),.006,m['white'])
    cylinder('tilt_joint',.010,.024,(0,-.031,.073),m['white'],segments=24,axis='X')
    for x in (-.0125,.0125):
        cylinder('joint_bolt',.003,.001,(x,-.031,.073),m['metal'],segments=12,axis='X')
    box('body_mount',(.017,.024,.025),(0,-.031,.087),m['white'])
    points=[(0,-.010,.118),(0,.014,.118),(0,.036,.105),(0,.046,.083),(0,.048,.053),(0,.077,.042)]
    for a,b in zip(points,points[1:]): tube('poe_cable',a,b,.003,m['dark'])
    for obj in list(bpy.context.scene.objects):
        if obj.type!='MESH': continue
        bpy.context.view_layer.objects.active=obj
        for mod in list(obj.modifiers): bpy.ops.object.modifier_apply(modifier=mod.name)
    bpy.context.view_layer.update()
    stats=report('SD-CCTV',limit=1.01,limit_reason='CCTV sheet envelope 40×180×150mm')
    if stats['problems']: raise RuntimeError(stats['problems'])
    export_glb(path)

if __name__=='__main__': build(sys.argv[sys.argv.index('--')+1])

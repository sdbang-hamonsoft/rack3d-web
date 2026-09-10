"""Latest workbook facilities. Metres, floor origin, Blender -Y front.
Run: Blender -b --python blender/objects/facilities.py -- public/models/objects
Dimensions follow each drawing, not the older overview sheet. No invented readings.
"""
import math
import os
import sys
import bpy
from mathutils import Vector
sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
from _common import box, cylinder, material, srgb, reset_scene, bevel_all, export_glb, report


def palette():
    return {k: material(k, srgb(c), m, r) for k,c,m,r in [
        ('frame','#2C3E50',.7,.3), ('metal','#9AA2AA',.8,.3),
        ('white','#F0F0F0',.1,.5), ('dark','#22252A',.1,.5),
        ('lens','#647780',.1,.15), ('red','#C0392B',.8,.2),
        ('pipe','#D35400',.8,.25), ('copper','#AC6340',.8,.3)]}


def tube(name, a, b, radius, mat, segments=12):
    a,b=Vector(a),Vector(b)
    obj=cylinder(name,radius,(b-a).length,(0,0,0),mat,segments=segments)
    obj.location=(a+b)/2
    obj.rotation_euler=(b-a).to_track_quat('Z','Y').to_euler()
    return obj


def ring(name, center, radius, mat, thickness=.002):
    bpy.ops.mesh.primitive_torus_add(major_radius=radius,minor_radius=thickness,
        major_segments=24,minor_segments=6,location=center)
    obj=bpy.context.object; obj.name=name; obj.data.materials.append(mat)
    return obj


def ellipsoid(name, center, scale, mat):
    bpy.ops.mesh.primitive_uv_sphere_add(segments=24,ring_count=12,location=center)
    obj=bpy.context.object; obj.name=name; obj.scale=scale; obj.data.materials.append(mat)
    for p in obj.data.polygons: p.use_smooth=True
    return obj


def battery(m):
    # 800×1000×2000, five tiers × four batteries, as the supplied drawing.
    box('skid',(.8,1,.065),(0,0,.0325),m['frame'])
    for x in (-.375,.375):
        for y in (-.475,.475):
            box('upright',(.045,.045,1.935),(x,y,1.0325),m['frame'])
    for z in (.095,1.97):
        for y in (-.475,.475): box('crossbeam',(.8,.045,.04),(0,y,z),m['metal'])
        for x in (-.375,.375): box('sidebeam',(.045,.95,.04),(x,0,z),m['metal'])
    for level in range(5):
        z=.14+level*.35
        box('shelf',(.73,.94,.025),(0,0,z),m['metal'])
        for x in (-.178,.178):
            for y in (-.235,.235):
                box('battery_module',(.33,.43,.265),(x,y,z+.145),m['dark'])
                box('battery_lid',(.338,.438,.025),(x,y,z+.2875),m['white'])
                for sx in (-1,1):
                    cylinder('terminal',.015,.022,(x+sx*.11,y-.13,z+.31),m['copper'],segments=12)
                    box('terminal_cap',(.04,.04,.01),(x+sx*.11,y-.13,z+.321),m['red'] if sx==1 else m['dark'])
                box('handle',(.10,.016,.045),(x,y-.223,z+.20),m['metal'])
            box('busbar',(.025,.48,.007),(x+.11,0,z+.327),m['copper'])
        # Side guards leave modules visible from all angles.
        for x in (-.375,.375): box('side_guard',(.025,.95,.055),(x,0,z+.20),m['frame'])
    box('fan_housing',(.40,.32,.08),(0,.20,1.91),m['metal'])
    cylinder('fan_well',.12,.004,(0,.20,1.953),m['dark'])
    for r in (.04,.065,.09,.115): ring('fan_guard',(0,.20,1.958),r,m['metal'])
    cylinder('fan_hub',.025,.01,(0,.20,1.958),m['metal'])


def suppression(m):
    # One cylinder; drawing footprint 450×400mm, nozzle height 2400mm.
    box('base',(.45,.4,.045),(0,0,.0225),m['frame'])
    for x in (-.2025,.2025): box('post',(.04,.035,1.82),(x,.175,.955),m['metal'])
    for z in (.32,1.1,1.82): box('mounting_rail',(.45,.035,.04),(0,.175,z),m['metal'])
    cylinder('vessel',.16,1.25,(0,0,.80),m['red'],segments=32)
    ellipsoid('vessel_bottom',(0,0,.175),(.16,.16,.13),m['red'])
    ellipsoid('vessel_shoulder',(0,0,1.425),(.16,.16,.15),m['red'])
    for z in (.34,1.1): ring('retaining_band',(0,0,z),.162,m['metal'],.009)
    cylinder('neck',.035,.10,(0,0,1.59),m['metal'])
    box('valve',(.075,.065,.065),(0,0,1.67),m['copper'])
    tube('handwheel_stem',(0,0,1.7),(0,0,1.75),.008,m['metal'])
    ring('handwheel',(0,0,1.75),.045,m['metal'],.005)
    tube('connection',(0,0,1.67),(.17,0,1.67),.02,m['pipe'])
    tube('riser',(.17,0,1.67),(.17,0,2.36),.02,m['metal'])
    tube('discharge',(.17,0,2.36),(-.18,0,2.36),.02,m['metal'])
    cylinder('nozzle',.035,.04,(-.18,0,2.38),m['metal'])
    tube('gauge_stem',(.07,0,1.67),(.07,-.08,1.72),.008,m['metal'])
    cylinder('gauge',.045,.025,(.07,-.095,1.72),m['metal'],axis='Y')
    cylinder('blank_dial',.036,.002,(.07,-.109,1.72),m['white'],axis='Y')


def sensor(m):
    # 80×60×120mm including connector and vented sensing cap. Local floor origin.
    box('mount_plate',(.08,.008,.075),(0,.022,.061),m['white'])
    body=box('housing',(.068,.050,.083),(0,-.001,.0595),m['white']); bevel_all(body,.005,3)
    box('display_bezel',(.055,.004,.045),(0,-.028,.063),m['dark'])
    box('blank_lcd',(.046,.002,.034),(0,-.031,.063),m['lens'])
    for x in (-.019,0,.019): box('status_lens',(.008,.002,.003),(x,-.028,.033),m['lens'])
    for x in (-.034,.034):
        for z in (.028,.092): cylinder('mount_screw',.003,.003,(x,-.026,z),m['metal'],segments=10,axis='Y')
    cylinder('sensing_cap',.020,.015,(0,0,.1075),m['white'])
    ellipsoid('dome',(0,0,.11),(.020,.020,.010),m['white'])
    for z in (.102,.107,.112): ring('vent',(0,0,z),.020,m['dark'],.001)
    cylinder('connector',.009,.018,(0,0,.009),m['metal'],segments=12)
    for z in (.004,.008,.012): ring('thread',(0,0,z),.009,m['dark'],.0007)


def water(m):
    # 40mm detector, 20mm tall, floor cable. No live blue LED is invented.
    cylinder('puck',.020,.018,(0,0,.011),m['white'],segments=32)
    cylinder('lid',.019,.002,(0,0,.021),m['white'],segments=32)
    ring('status_lens',(0,0,.022),.016,m['lens'],.001)
    for x in (-.025,.025):
        cylinder('mount_lug',.007,.003,(x,0,.0015),m['white'],segments=16)
        cylinder('mount_hole',.002,.0005,(x,0,.0033),m['dark'],segments=12)
    for x in (-.012,.012): cylinder('contact',.002,.004,(x,0,.002),m['metal'],segments=10)
    points=[(0,.018,.007),(0,.055,.005),(.035,.09,.004),(.08,.11,.004),(.13,.11,.004)]
    for a,b in zip(points,points[1:]): tube('cable',a,b,.003,m['white'])
    tube('cable_connector',(.13,.11,.004),(.15,.11,.004),.004,m['metal'])


def door(m):
    # 900×2100mm glass door, closed; sensor pair on lintel. No invented walls.
    glass=material('door_glass',srgb('#B6D6DE'),.05,.16)
    bsdf=glass.node_tree.nodes['Principled BSDF']; bsdf.inputs['Alpha'].default_value=.23
    glass.surface_render_method='DITHERED'
    for x in (-.433,.433): box('frame_post',(.034,.04,2.1),(x,0,1.05),m['metal'])
    for z in (.017,2.083): box('frame_crossbar',(.9,.04,.034),(0,0,z),m['metal'])
    box('glass_panel',(.832,.012,2.032),(0,0,1.05),glass)
    for z in (.28,1.82): box('hinge',(.04,.030,.085),(-.407,-.01,z),m['metal'])
    for y in (-.04,.04):
        tube('pull_handle',(.34,y,.94),(.34,y,1.23),.008,m['metal'])
        for z in (.94,1.23): tube('handle_standoff',(.34,0,z),(.34,y,z),.006,m['metal'])
    box('sensor_main',(.05,.015,.025),(0,-.027,2.075),m['white'])
    box('sensor_magnet',(.05,.015,.015),(0,-.019,2.040),m['white'])
    box('floor_closer',(.12,.08,.015),(-.35,0,.0075),m['metal'])


BUILDERS={'battery-rack':battery,'gas-suppression':suppression,
          'temperature-humidity-sensor':sensor,'water-leak-sensor':water,'door':door}

def build(name, path):
    reset_scene(); BUILDERS[name](palette())
    # Bake per-object bevels before merging material groups (see UPS).
    for obj in list(bpy.context.scene.objects):
        if obj.type!='MESH': continue
        bpy.context.view_layer.objects.active=obj
        for mod in list(obj.modifiers): bpy.ops.object.modifier_apply(modifier=mod.name)
    bpy.context.view_layer.update()
    stats=report(name,limit=1.01,limit_reason='사용자 제공 종별 치수 도면. 배터리랙 800×1000mm.')
    if stats['problems']: raise RuntimeError(stats['problems'])
    os.makedirs(os.path.dirname(path),exist_ok=True); export_glb(path)

if __name__=='__main__':
    out=sys.argv[sys.argv.index('--')+1]
    for name in BUILDERS: build(name,os.path.join(out,name+'.glb'))

"""Google workbook sheets 12–15, downloaded 2026-09-11.
Metres, bottom-centred origin, -Y front. Ambiguous drawing dimensions resolved
in docs/layout-object-modeling-plan.md. Indicators are unlit, readings absent.
"""
import math
import os
import sys
import bpy
sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
from _common import box, cylinder, bevel_all, reset_scene, export_glb, report
from facilities import palette, tube, ring


def rounded(name,size,center,mat,r=.002):
    obj=box(name,size,center,mat); bevel_all(obj,r,3); return obj


def board(m):
    # Closed 800×600×2200 enclosure including feet, door and handle.
    for x in (-.31,.31):
        for y in (-.21,.21): box('foot',(.09,.10,.06),(x,y,.03),m['dark'])
    rounded('cabinet',(.798,.56,2.14),(0,.02,1.13),m['white'],.008)
    rounded('door_seam',(.775,.008,2.10),(0,-.264,1.13),m['dark'],.005)
    rounded('door',(.762,.014,2.085),(0,-.275,1.13),m['white'],.005)
    for z in (.35,1.1,1.85): box('hinge',(.012,.018,.085),(.382,-.265,z),m['metal'])
    rounded('handle_base',(.035,.008,.18),(-.305,-.286,1.05),m['dark'])
    box('handle',(.012,.008,.13),(-.305,-.296,1.06),m['metal'])
    cylinder('keyhole',.006,.001,(-.305,-.291,.982),m['dark'],axis='Y',segments=12)
    # Door-mounted metering panel, no fabricated volts/amps or switch state labels.
    rounded('meter_panel',(.32,.009,.60),(0,-.2865,1.54),m['metal'],.004)
    for x in (-.10,0,.10):
        rounded('meter_bezel',(.082,.003,.09),(x,-.2925,1.745),m['dark'])
        box('blank_meter',(.065,.001,.065),(x,-.2945,1.747),m['lens'])
    for x in (-.085,.085):
        box('breaker',(.10,.005,.18),(x,-.2935,1.52),m['dark'])
        box('breaker_inset',(.069,.001,.13),(x,-.2965,1.52),m['metal'])
        box('breaker_handle',(.034,.003,.035),(x,-.2985,1.52),m['dark'])
    for x in (-.11,-.055,0,.055,.11):
        cylinder('inactive_indicator',.012,.002,(x,-.293,1.815),m['lens'],axis='Y',segments=16)
    for i in range(12):
        box('panel_vent',(.012,.002,.033),(-.132+i*.024,-.293,1.285),m['dark'])
    for y in (-.13,-.10,-.07,-.04,-.01,.02,.05,.08,.11,.14):
        
        for x in (-.3995,.3995): box('side_louver',(.001,.012,.21),(x,y,1.88),m['dark'])


def sensor_base(m,width,height):
    rounded('mounting_base',(width,.1,.004),(0,0,.002),m['metal'])
    rounded('housing',(.1,.08,height),(0,0,.004+height/2),m['metal'],.004)
    for x in (-width/2+.012,width/2-.012):
        for y in (-.035,.035):
            cylinder('anchor_recess',.004,.0005,(x,y,.0043),m['dark'],segments=12)
    for x in (-.043,.043):
        for y in (-.033,.033):
            cylinder('cover_screw',.003,.001,(x,y,height+.0045),m['dark'],segments=12)
    for x in [i*.008 for i in range(-5,6)]:
        for y in (-.041,.041): box('cooling_fin',(.002,.003,height-.01),(x,y,.004+height/2),m['metal'])
    for x in (-.051,.051):
        for y in (-.026,-.013,0,.013,.026): box('side_fin',(.003,.003,height-.01),(x,y,.004+height/2),m['metal'])
    for x in (-.020,.020):
        cylinder('connector',.007,.007,(x,-.0435,.023),m['metal'],axis='Y',segments=16)
        cylinder('connector_socket',.0045,.001,(x,-.0475,.023),m['dark'],axis='Y',segments=16)


def seismic(m):
    sensor_base(m,.15,.060)
    cylinder('top_disc',.034,.007,(0,0,.0685),m['metal'],segments=32)
    ring('inactive_status_ring',(0,0,.074),.029,m['lens'],.002)
    cylinder('sensor_cap',.026,.008,(0,0,.076),m['metal'],segments=32)
    for x in (-.043,.043): box('direction_mark',(.007,.001,.002),(x,-.044,.036),m['dark'])


def fire(m):
    sensor_base(m,.16,.038)
    cylinder('optical_chamber',.033,.014,(0,0,.050),m['dark'],segments=32)
    cylinder('chamber_base',.036,.004,(0,0,.044),m['metal'],segments=32)
    for i in range(16):
        a=i*math.tau/16
        tube('chamber_rib',(.032*math.cos(a),.032*math.sin(a),.045),
             (.027*math.cos(a),.027*math.sin(a),.062),.002,m['metal'],segments=8)
    cylinder('detector_lid',.030,.005,(0,0,.0645),m['metal'],segments=32)
    cylinder('lid_cap',.026,.003,(0,0,.0685),m['white'],segments=32)
    for x in (-.012,0,.012):
        box('inactive_status_window',(.007,.001,.004),(x,-.044,.034),m['lens'])


def tag_reader(m):
    # 220×150×110mm per front/side views. Ignore copied sensor bottom view.
    rounded('mounting_plate',(.22,.006,.11),(0,.072,.055),m['metal'],.005)
    rounded('reader_body',(.206,.133,.10),(0,.0025,.055),m['white'],.009)
    rounded('front_bezel',(.214,.006,.104),(0,-.067,.055),m['dark'],.005)
    rounded('front_panel',(.205,.003,.096),(0,-.0715,.055),m['metal'],.004)
    rounded('rfid_pad',(.080,.001,.077),(-.055,-.0735,.055),m['white'],.004)
    # Embossed contactless waves, no screen texture.
    cylinder('rfid_dot',.003,.001,(-.055,-.0745,.055),m['dark'],axis='Y',segments=12)
    for sign in (-1,1):
        for r in (.012,.020,.028):
            pts=[(-.055+sign*r*math.cos(a),-.0745,.055+r*math.sin(a)) for a in [(-.65+j*1.3/10) for j in range(11)]]
            for a,b in zip(pts,pts[1:]): tube('rfid_wave',a,b,.0005,m['dark'],segments=6)
    box('blank_display',(.063,.001,.020),(.050,-.074,.085),m['lens'])
    for row in range(4):
        for col in range(3):
            x=.027+col*.024; z=.063-row*.015
            rounded('key',(.019,.002,.011),(x,-.074,z),m['dark'],.001)
            box('key_mark',(.004,.0003,.001),(x,-.07515,z),m['metal'])
    for z in (.035,.049,.063): box('rear_vent',(.001,.04,.003),(.1035,.025,z),m['dark'])


BUILDERS={'distribution-board':board,'seismic-sensor':seismic,'fire-detector':fire,'access-tag-reader':tag_reader}

def build(name,path):
    reset_scene(); BUILDERS[name](palette())
    for obj in list(bpy.context.scene.objects):
        if obj.type!='MESH': continue
        bpy.context.view_layer.objects.active=obj
        for mod in list(obj.modifiers): bpy.ops.object.modifier_apply(modifier=mod.name)
    bpy.context.view_layer.update()
    stats=report(name,limit=1.01,limit_reason='Sheet dimension: distribution board 800×600mm')
    if stats['problems']: raise RuntimeError(stats['problems'])
    export_glb(path)

if __name__=='__main__':
    out=sys.argv[sys.argv.index('--')+1]
    for name in BUILDERS: build(name,os.path.join(out,name+'.glb'))

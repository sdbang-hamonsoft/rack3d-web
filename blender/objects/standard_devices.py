"""Standard server/network 1–10U. Workbook dimensions; front +Z after glTF export.
Unlike floor equipment, rack devices have their vertical centre at zero.
Front mounting plane is z=0.410m in rack coordinates (ahead of the mounting rails).
Run: Blender -b --python blender/objects/standard_devices.py -- public/models
"""
import os
import sys
import bpy
sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
from _common import box, cylinder, material, srgb, reset_scene, export_glb, bevel_all


def build(kind, units, out):
    reset_scene()
    height=units*.04445
    depth=.8 if kind=='server' else (.35 if units==1 else .45 if units==2 else .55 if units<=4 else .6 if units<=7 else .65)
    front=-.410
    shell=material('chassis',srgb('#1E2022' if kind=='server' else '#2B2D31'),.85,.3)
    panel=material('module',srgb('#3A3D40'),.75,.3)
    dark=material('recess',srgb('#090C10'),.1,.5)
    metal=material('metal',srgb('#9AA2AA'),.9,.25)
    lens=material('unlit_lens',srgb('#657780'),.1,.2)
    chassis=box('chassis',(.43,depth-.012,height-.001),(0,front+depth/2,0),shell)
    bevel_all(chassis,.0004,1)
    bpy.context.view_layer.objects.active=chassis
    bpy.ops.object.modifier_apply(modifier=chassis.modifiers[0].name)
    box('front_panel',(.483,.004,height-.001),(0,front+.002,0),shell)
    for x in (-.232,.232):
        for z in (-height*.30,height*.30):
            cylinder('mount_screw',.003,.003,(x,front-.0015,z),metal,segments=8,axis='Y')
    if kind=='server':
        rows=2 if units==1 else min(5,units+1)
        columns=3 if units<6 else 8
        rows=rows if units<6 else 1
        cell_h=(height-.008)/rows
        cell_w=.348/columns
        for row in range(rows):
            for col in range(columns):
                x=-.204+(col+.5)*cell_w
                z=-height/2+.004+(row+.5)*cell_h
                box('drive_recess',(cell_w-.003,.004,cell_h-.002),(x,front-.002,z),dark)
                box('drive_tray',(cell_w-.007,.003,cell_h-.006),(x,front-.004,z),panel)
                box('latch',(.007,.004,min(.03,cell_h-.008)),(x+cell_w/2-.01,front-.006,z),metal)
                for j in range(3):
                    box('tray_vent',(cell_w-.025,.001,.001),(x-.005,front-.006,z+(j-1)*min(.004,cell_h/6)),dark)
        for j in range(max(2,units*2)):
            box('control_grille',(.047,.002,.002),(.176,front-.002,-height*.37+j*height*.74/max(1,units*2-1)),dark)
        cylinder('power_button',.004,.003,(.203,front-.003,height*.22),metal,segments=10,axis='Y')
    else:
        rows=2 if units==1 else units
        for row in range(rows):
            z=-height/2+(row+.5)*height/rows
            for col in range(12):
                x=-.196+col*.028
                box('port_cage',(.023,.005,.016),(x,front-.002,z),metal)
                box('port_socket',(.019,.002,.012),(x,front-.0055,z),dark)
                box('port_contacts',(.013,.001,.002),(x,front-.0065,z-.003),panel)
                box('port_lens',(.002,.001,.002),(x+.01,front-.0055,z+.007),lens)
        for x in (.16,.19):
            box('uplink_cage',(.024,.005,.013),(x,front-.002,0),metal)
            box('uplink_socket',(.02,.002,.009),(x,front-.0055,0),dark)
    # Rear redundant PSUs, fans, management connectors, not photos from another vendor.
    rear=front+depth
    for x in (-.155,-.05):
        box('psu',(.095,.008,height*.70),(x,rear-.004,0),panel)
        box('power_socket',(.019,.002,.015),(x+.023,rear+.001,0),dark)
        cylinder('psu_fan',min(.018,height*.28),.002,(x-.018,rear+.001,0),dark,segments=16,axis='Y')
        for j in range(3): box('fan_guard',(.032,.001,.001),(x-.018,rear+.002,(j-1)*.006),metal)
    for x in (.035,.062,.089,.116):
        box('rear_port',(.02,.002,.012),(x,rear+.001,0),dark)
    for x in (-.216,.216):
        box('slide_rail',(.003,depth*.7,.01),(x,front+depth*.52,0),metal)
    outpath=os.path.join(out,f'standard-{kind}-{units}u.glb')
    export_glb(outpath)

if __name__=='__main__':
    out=sys.argv[sys.argv.index('--')+1]; os.makedirs(out,exist_ok=True)
    for kind in ('server','network'):
        for units in range(1,11): build(kind,units,out)

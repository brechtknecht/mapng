# Convert a mapng Google-tiles GLB into a BeamNG-compatible COLLADA (.dae).
#
# REQUIRES Blender 3.x or 4.x (4.2 LTS recommended) — Collada export was
# REMOVED in Blender 5.0+. A portable 4.2 zip from
# https://download.blender.org/release/Blender4.2/ works without installing.
#
# Usage:
#   blender --background --factory-startup --python beamng_glb_to_dae.py -- input.glb output.dae
#
# Why Blender: BeamNG's Torque-era DAE importer has undocumented constraints
# (16-bit vertex indices per mesh, trailing digits in node names parsed as LOD
# sizes, ...). Blender's Collada exporter is the path the BeamNG modding
# community itself uses, so we export a clean GLB from mapng and let Blender
# do the final serialization.
#
# The GLB is authored so that the glTF(Y-up) -> Blender(Z-up) import rotation
# lands the model exactly in BeamNG world coordinates; the Collada export
# below writes Z_UP, which BeamNG reads as-is.

import bpy
import re
import sys


def main():
    argv = sys.argv
    if '--' not in argv or len(argv) < argv.index('--') + 3:
        print('usage: blender --background --factory-startup --python '
              'beamng_glb_to_dae.py -- <input.glb> <output.dae>')
        sys.exit(1)
    args = argv[argv.index('--') + 1:]
    src, dst = args[0], args[1]

    # Empty scene (no default cube/camera/light).
    bpy.ops.wm.read_factory_settings(use_empty=True)

    bpy.ops.import_scene.gltf(filepath=src)
    meshes = [ob for ob in bpy.data.objects if ob.type == 'MESH']
    if not meshes:
        print(f'ERROR: no meshes found in {src}')
        sys.exit(1)

    # --- Sanitize names -----------------------------------------------------
    # Torque parses TRAILING DIGITS in a node name as the LOD detail size
    # ("Colmesh-1" relies on this; "foo000" = render at 0 px = invisible).
    # Blender also deduplicates names with ".001" suffixes - both must go.
    def safe_name(name):
        name = name.replace('.', '_')
        if re.search(r'\d$', name):
            name += '_m'
        return name

    seen = set()
    for ob in meshes:
        base = safe_name(ob.name)
        name = base
        n = 0
        while name in seen:
            n += 1
            name = f'{base}_d{n}_m'
        seen.add(name)
        ob.name = name
        if ob.data:
            ob.data.name = name

    # Material names must match the entries in main.materials.json exactly -
    # strip Blender's ".001" dedup suffixes (mapng guarantees unique names).
    for mat in bpy.data.materials:
        mat.name = re.sub(r'\.\d+$', '', mat.name)

    # --- BeamNG node skeleton: base00 > start01 > [meshes] ------------------
    base00 = bpy.data.objects.new('base00', None)
    start01 = bpy.data.objects.new('start01', None)
    bpy.context.scene.collection.objects.link(base00)
    bpy.context.scene.collection.objects.link(start01)
    start01.parent = base00

    for ob in meshes:
        # Keep the world transform the glTF import produced, re-parented flat
        # under start01 (the importer may have added intermediate empties).
        world = ob.matrix_world.copy()
        ob.parent = start01
        ob.matrix_world = world

    # Remove leftover non-mesh import empties (glTF scene roots etc.).
    for ob in list(bpy.data.objects):
        if ob.type == 'EMPTY' and ob not in (base00, start01):
            bpy.data.objects.remove(ob, do_unlink=True)

    # --- Export -------------------------------------------------------------
    # BeamNG resolves textures via main.materials.json, not via the DAE's
    # <library_images>, so texture copying is disabled.
    bpy.ops.wm.collada_export(
        filepath=dst,
        apply_modifiers=True,
        triangulate=True,
        use_texture_copies=False,
        export_global_up_selection='Z',
        export_global_forward_selection='Y',
        apply_global_orientation=False,
    )
    print(f'OK: wrote {dst} ({len(meshes)} meshes)')


if __name__ == '__main__':
    main()

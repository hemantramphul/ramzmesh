"""
Makes Blender materials survive FBX export (for RamzMesh, Sketchfab, game engines...).

Blender's FBX exporter only understands a Principled BSDF plugged into the Material Output.
Any other shader (Metallic BSDF, Glass BSDF, Mix Shader, Transparent BSDF...) is skipped and the
part is exported with its plain viewport color: metal turns into plastic, glass turns solid.

This script plugs a Principled BSDF with matching settings into each of those materials:
    Metallic / Glossy BSDF   -> Metallic 1, same color and roughness
    Glass / Refraction BSDF  -> see-through (Alpha), same color and roughness
      mixed with Transparent -> clearer still
    Diffuse BSDF             -> same color, matte
    Emission                 -> same glow (Emission color and strength)
    Transparent BSDF         -> invisible (Alpha 0)
The old nodes stay in the material, just unplugged, so nothing is lost.

How to use:
    1. Save your .blend under a new name (File > Save As) to keep the original.
    2. Scripting tab > Text > Open > this file, then Run Script (the play button, or Alt+P).
    3. A list of the changed materials pops up. Export as usual: File > Export > FBX.
"""

import bpy

GLASS_ALPHA = 0.3  # how see-through glass is: 0 = invisible, 1 = solid
CLEAR_GLASS_ALPHA = 0.15  # glass mixed with a Transparent BSDF

# Your own changes, applied last: material name -> {Principled BSDF setting: value}.
# Setting names are the English ones: "Base Color", "Metallic", "Roughness", "Alpha"...
# Numbers go from 0 to 1; a color is written (red, green, blue, 1). Delete a line to undo it.
TWEAKS = {
    "Opaque(0,6,53)": {"Alpha": 1.0},  # blue dome on top: solid instead of see-through
    "pa11": {"Roughness": 0.5},  # tires: a little shine, so they show on a dark background
}

# Give whole parts a color of their own: object or assembly name -> color (red, green, blue, 1).
# Only those parts change, even when their materials are shared with the rest of the model.
# The name is the one in the Outliner; an assembly brings all the parts inside it.
PAINT = {
    "camera_A8": (0.01, 0.01, 0.01, 1),  # camera inside the front dome: black
}

METAL = ("BSDF_METALLIC", "BSDF_GLOSSY", "BSDF_ANISOTROPIC")
GLASS = ("BSDF_GLASS", "BSDF_REFRACTION")
# The shader that gives a mix its look, most important first
MAIN_ORDER = ("BSDF_PRINCIPLED", *GLASS, *METAL, "BSDF_DIFFUSE", "EMISSION", "BSDF_TRANSPARENT")


def shaders_in(node):
    """The shaders a Mix / Add Shader is made of (reroutes followed)."""
    if node.type == "REROUTE":
        link = node.inputs[0].links[0] if node.inputs[0].is_linked else None
        return shaders_in(link.from_node) if link else []
    if node.type in ("MIX_SHADER", "ADD_SHADER"):
        found = []
        for s in node.inputs:
            if s.type == "SHADER" and s.is_linked:
                found += shaders_in(s.links[0].from_node)
        return found
    return [node]


def copy(tree, src, src_name, dst, dst_name):
    """Copy a setting, or whatever is plugged into it (an image texture, for example)."""
    s = src.inputs.get(src_name)
    if s is None:
        return
    if s.is_linked:
        tree.links.new(s.links[0].from_socket, dst.inputs[dst_name])
    elif hasattr(s, "default_value"):
        dst.inputs[dst_name].default_value = s.default_value


def metal_color(node):
    """A Metallic BSDF set to 'Physical Conductor' has no color, only IOR and extinction: work it out."""
    n = node.inputs["IOR"].default_value
    k = node.inputs["Extinction"].default_value
    return [((a - 1) ** 2 + b * b) / ((a + 1) ** 2 + b * b) for a, b in zip(n[:3], k[:3])] + [1.0]


def material_output(mat):
    """The Material Output node in use, if something is plugged into its Surface."""
    outputs = [n for n in mat.node_tree.nodes if n.type == "OUTPUT_MATERIAL"]
    out = next((n for n in outputs if n.is_active_output), outputs[0] if outputs else None)
    return out if out is not None and out.inputs["Surface"].is_linked else None


def convert(mat):
    tree = mat.node_tree
    out = material_output(mat)
    if out is None:
        return None
    surface = out.inputs["Surface"].links[0].from_node
    if surface.type == "BSDF_PRINCIPLED":
        return None  # already fine
    parts = shaders_in(surface)
    kinds = {n.type for n in parts}
    unknown = kinds - set(MAIN_ORDER)
    if unknown or not parts:
        return f"left as is (uses {', '.join(sorted(unknown)) or 'nothing'})"
    main = next(n for t in MAIN_ORDER for n in parts if n.type == t)

    p = tree.nodes.new("ShaderNodeBsdfPrincipled")
    p.label = "For FBX export"
    p.location = (out.location.x - 320, out.location.y + 380)
    # A new Principled BSDF has a white emission at strength 0; the FBX would keep the white
    # and some viewers would make the part glow, so no glow unless the material had one
    p.inputs["Emission Color"].default_value = (0, 0, 0, 1)
    t = main.type
    if t == "BSDF_PRINCIPLED":
        for name in ("Base Color", "Metallic", "Roughness", "Alpha", "Emission Color", "Emission Strength"):
            copy(tree, main, name, p, name)
        what = "Principled BSDF"
    elif t in METAL:
        if getattr(main, "fresnel_type", "") == "PHYSICAL_CONDUCTOR":
            p.inputs["Base Color"].default_value = metal_color(main)
        else:
            copy(tree, main, "Base Color" if "Base Color" in main.inputs else "Color", p, "Base Color")
        copy(tree, main, "Roughness", p, "Roughness")
        p.inputs["Metallic"].default_value = 1.0
        what = "metal"
    elif t in GLASS:
        copy(tree, main, "Color", p, "Base Color")
        copy(tree, main, "Roughness", p, "Roughness")
        p.inputs["Alpha"].default_value = GLASS_ALPHA
        what = "glass"
    elif t == "BSDF_DIFFUSE":
        copy(tree, main, "Color", p, "Base Color")
        p.inputs["Roughness"].default_value = 1.0
        what = "matte"
    elif t == "EMISSION":
        p.inputs["Base Color"].default_value = (0, 0, 0, 1)
        copy(tree, main, "Color", p, "Emission Color")
        copy(tree, main, "Strength", p, "Emission Strength")
        what = "glow"
    else:  # Transparent BSDF on its own
        copy(tree, main, "Color", p, "Base Color")
        p.inputs["Alpha"].default_value = 0.0
        what = "invisible"

    # Mixed in with the main shader: transparency and glow
    if "BSDF_TRANSPARENT" in kinds and t != "BSDF_TRANSPARENT":
        p.inputs["Alpha"].default_value = CLEAR_GLASS_ALPHA if t in GLASS else 0.5
        what += " + transparent"
    glow = next((n for n in parts if n.type == "EMISSION"), None)
    if glow and t != "EMISSION":
        copy(tree, glow, "Color", p, "Emission Color")
        copy(tree, glow, "Strength", p, "Emission Strength")
        what += " + glow"
    copy(tree, main, "Normal", p, "Normal")

    tree.links.new(p.outputs["BSDF"], out.inputs["Surface"])
    if p.inputs["Alpha"].default_value < 1 and hasattr(mat, "surface_render_method"):
        mat.surface_render_method = "BLENDED"  # see-through in the viewport too
    alpha = p.inputs["Alpha"].default_value
    return f"{surface.name} -> {what}" + (f" (Alpha {alpha:.2f})" if alpha < 1 else "")


parts = {}  # material name -> how many objects use it
for obj in bpy.data.objects:
    for slot in getattr(obj, "material_slots", []):
        if slot.material:
            parts[slot.material.name] = parts.get(slot.material.name, 0) + 1

report = []
for mat in bpy.data.materials:
    if mat.node_tree is None or mat.library is not None:
        continue
    result = convert(mat)
    if result:
        report.append(f"{mat.name}  ({parts.get(mat.name, 0)} parts):  {result}")

for name, settings in TWEAKS.items():
    mat = bpy.data.materials.get(name)
    out = mat and mat.node_tree and material_output(mat)
    p = out and out.inputs["Surface"].links[0].from_node
    if not p or p.type != "BSDF_PRINCIPLED":
        report.append(f"{name}:  tweak skipped (no such material, or not a Principled BSDF)")
        continue
    for setting, v in settings.items():
        p.inputs[setting].default_value = v
    if "Alpha" in settings and hasattr(mat, "surface_render_method"):
        mat.surface_render_method = "BLENDED" if settings["Alpha"] < 1 else "DITHERED"
    report.append(f"{name}:  " + ", ".join(f"{k} {v}" for k, v in settings.items()))


def paint_material(root_name, color):
    """A plain Principled BSDF material just for these parts, made once and reused."""
    name = f"Paint {root_name}"
    mat = bpy.data.materials.get(name) or bpy.data.materials.new(name)
    if mat.node_tree is None:
        mat.use_nodes = True
    out = material_output(mat)
    p = out and out.inputs["Surface"].links[0].from_node
    if not p or p.type != "BSDF_PRINCIPLED":
        mat.node_tree.nodes.clear()
        out = mat.node_tree.nodes.new("ShaderNodeOutputMaterial")
        p = mat.node_tree.nodes.new("ShaderNodeBsdfPrincipled")
        p.location = (out.location.x - 320, out.location.y)
        mat.node_tree.links.new(p.outputs["BSDF"], out.inputs["Surface"])
    p.inputs["Base Color"].default_value = color
    p.inputs["Metallic"].default_value = 0.0
    p.inputs["Roughness"].default_value = 0.4  # a soft shine, so the shape still shows when dark
    p.inputs["Alpha"].default_value = 1.0
    p.inputs["Emission Color"].default_value = (0, 0, 0, 1)
    mat.diffuse_color = color  # the viewport color too
    return mat


for root_name, color in PAINT.items():
    root = bpy.data.objects.get(root_name)
    if root is None:
        report.append(f"{root_name}:  paint skipped (no object with that name)")
        continue
    mat = paint_material(root_name, color)
    painted = 0
    for obj in [root, *root.children_recursive]:
        if obj.type != "MESH":
            continue
        for slot in obj.material_slots:
            slot.link = "OBJECT"  # on this object only: the mesh, maybe shared, keeps its materials
            slot.material = mat
        painted += 1
    report.append(f"{root_name}:  {painted} parts painted")

lines = report or ["Nothing to change: every material already uses a Principled BSDF."]
print("\n".join(["Materials ready for FBX:"] + lines))
if not bpy.app.background:

    def draw(self, context):
        for line in lines:
            self.layout.label(text=line)
        if report:
            self.layout.label(text="Now export: File > Export > FBX")

    bpy.context.window_manager.popup_menu(draw, title="Materials ready for FBX", icon="INFO")

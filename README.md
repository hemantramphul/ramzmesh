# RamzMesh

[![Live demo](https://img.shields.io/badge/Live%20demo-RamzMesh-1caad9?logo=githubpages&logoColor=white)](https://hemantramphul.github.io/ramzmesh/)
[![Deploy to GitHub Pages](https://github.com/hemantramphul/ramzmesh/actions/workflows/pages/pages-build-deployment/badge.svg)](https://github.com/hemantramphul/ramzmesh/actions/workflows/pages/pages-build-deployment)

Publish, share and embed interactive 3D models with annotations, right in the browser.

<a href="assets/images/image.png"><img src="assets/images/image.png" alt="RamzMesh editor: 3D viewer with the annotation panel on the right"></a>

RamzMesh is a 3D viewer for STL and FBX files. Open a model, click on it to place numbered annotations, then share a link where visitors can rotate the model and read each point's info. It's plain HTML, CSS and JavaScript ([Three.js](https://threejs.org)): no build step and no backend.

## Features

- A start page to choose the STL or the FBX viewer
- Open any `.stl` file (button or drag and drop)
- Open `.fbx` files with their colors and textures
- Click on the model to add annotations with a title, a description and a saved camera angle
- Edit, move, reorder and delete annotations
- Annotations auto-save in your browser; export and import them as `annotations.json`
- View mode for visitors: clickable hotspots, auto-rotate and fullscreen
- Hotspots fade when they're behind the model
- Z-up / Y-up switch for CAD and 3D-printing files
- Fast on large meshes

## Run it locally

Models are loaded over HTTP, so serve the folder instead of double-clicking the HTML files. Either way works:

**VS Code Live Server**: install the [Live Server](https://marketplace.visualstudio.com/items?itemName=ritwickdey.LiveServer) extension, right-click `index.html` and choose **Open with Live Server**. It opens <http://127.0.0.1:5500> and reloads the page when you save a file.

**Python**: from the project folder, run:

```bash
python -m http.server 8000
```

Then open <http://localhost:8000>.

Choose STL or FBX on the start page.

## Add a model

1. Open `stl.html` and click **Open STL**.
2. Click **+ Add annotation**, click a spot on the model, then fill in a title and description.
3. Click **Export** to download `annotations.json`.
4. Make a folder in `stl/` and put both files in it. The STL must be named `model.stl`:

   ```
   stl/
     hiiro/
       model.stl
       annotations.json
   ```

5. Share the link: `stl.html?view&file=hiiro`

Folder names can use letters, numbers, `-` and `_`.

## FBX models (colors and textures)

`fbx.html` is the same viewer and annotation editor for `.fbx` files. Unlike STL, an FBX keeps its own colors and textures.

- Textures packed inside the FBX show up on their own. If the textures are separate image files, select or drop them together with the `.fbx`. They're matched by file name.
- A texture that can't be found is left out, so the surface shows its plain material color instead of turning black.
- Animations don't play: the model stays in its rest pose so annotation points stay where you put them.
- FBX files start Y-up. If yours is lying on its side, use the Z↑ / Y↑ button.
- To publish one, put it in `fbx/<name>/model.fbx` with its `annotations.json` and any separate texture files, then share `fbx.html?view&file=<name>`. The URL parameters are the same as for STL.

FBX annotations are saved separately from STL ones. The FBX page's code is in `assets/js/fbx.js`, a copy of `main.js`, so changes to the STL page don't affect it.

## URL parameters

| Parameter    | Example            | What it does                                    |
| ------------ | ------------------ | ----------------------------------------------- |
| `file`       | `file=hiiro`       | Loads `stl/hiiro/model.stl` and its annotations |
| `view`       | `view`             | Visitor mode: no side panel, auto-rotate on     |
| `edit`       | `edit`             | Allows editing when `editable` is `false`       |
| `home`       | `home=false`       | Hides the reset view button                     |
| `autorotate` | `autorotate=false` | Hides the auto-rotate button                    |
| `fullscreen` | `fullscreen=false` | Hides the fullscreen button                     |

Without `file`, `stl.html` opens empty, ready for a new STL.

Older links to the site root with `file`, `view` or `edit` (like `/?view&file=hiiro`) still open the STL viewer: the start page forwards them to `stl.html`.

## Embed on a website

```html
<iframe
  src="https://your-site.com/stl.html?view&file=hiiro"
  width="100%"
  height="600"
  style="border: 0"
  allow="fullscreen"
></iframe>
```

## Controls

- Drag to rotate, scroll to zoom, right-drag to pan
- `←` / `→` step through annotations, `Esc` closes the info panel
- In view mode, click a hotspot to open its info; click it again or anywhere else to close it

## Settings

Edit `CONFIG` at the top of `assets/js/main.js` (STL) or `assets/js/fbx.js` (FBX):

| Setting          | Default   | What it does                                                                         |
| ---------------- | --------- | ------------------------------------------------------------------------------------ |
| `zUp`            | `true`    | Default up axis (most CAD and 3D-printing STLs are Z-up; `false` for FBX)            |
| `modelColor`     | `#c9ccd3` | Model color (STL only)                                                               |
| `annotationZoom` | `0.6`     | How close the camera gets to an opened annotation                                    |
| `zoomIn`         | `0.5`     | Closest you can zoom in (smaller = closer)                                           |
| `zoomOut`        | `2`       | Farthest you can zoom out, × the whole-model view (bigger = farther)                 |
| `viewZoom`       | `1.3`     | View mode: how much closer visitors start, as long as the model still fits on screen |
| `editable`       | `true`    | Set to `false` so visitors can only view (`?edit` still edits)                       |

## Project structure

```
index.html            Start page: choose the STL or FBX viewer
stl.html              STL viewer and annotation editor
assets/css/style.css  Viewer styles
assets/css/main.css   Start page styles
assets/css/footer.css Author credits (social links, "Ramz" gradient), shared by all pages
assets/js/main.js     STL viewer logic and settings
fbx.html              FBX viewer and annotation editor
assets/js/fbx.js      FBX viewer logic and settings (a copy of main.js)
assets/js/vendor/     Three.js and three-mesh-bvh (bundled, nothing to install)
assets/css/vendor/    Bootstrap Icons (bundled icon font)
stl/<name>/           One folder per model: model.stl + annotations.json
fbx/<name>/           One folder per FBX model: model.fbx + annotations.json (+ texture files)
```

## Author

Built by **Hemant Ramphul**.

- LinkedIn: [hemantramphul](https://www.linkedin.com/in/hemantramphul/)
- GitHub: [@hemantramphul](https://github.com/hemantramphul/)
- Email: [hemantramphul@gmail.com](mailto:hemantramphul@gmail.com?subject=RamzMesh)

If [RamzMesh](https://hemantramphul.github.io/ramzmesh/) is useful to you, you can buy me a coffee:

[![Buy me a coffee](https://img.shields.io/badge/Buy%20me%20a%20coffee-ffdd00?style=for-the-badge&logo=buymeacoffee&logoColor=black)](https://buymeacoffee.com/hemant.ramphul)

## License

[GPL-3.0](LICENSE). Bundled libraries: [Three.js](https://github.com/mrdoob/three.js) (including its FBX loader and [fflate](https://github.com/101arrowz/fflate)), [three-mesh-bvh](https://github.com/gkjohnson/three-mesh-bvh) and [Bootstrap Icons](https://icons.getbootstrap.com), all MIT (licenses in `assets/js/vendor/` and `assets/css/vendor/`).

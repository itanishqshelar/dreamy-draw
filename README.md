<img width="1774" height="400" alt="dreamy-draw" src="https://github.com/user-attachments/assets/7fd70fb9-9540-4dec-bc66-887241ed5463" />


DreamyDraw is a local-first whiteboard with an Excalidraw-style interface. Drawings are stored in the user's browser with IndexedDB, so the app can keep multiple sessions without a cloud database.

## Features

- **Infinite canvas** with pan (space-drag, hand tool, or scroll) and zoom (Ctrl/⌘ + scroll, or the zoom controls).
- **Tools:** selection, hand, rectangle, diamond, ellipse, arrow, line, freehand draw, text, and eraser — each with a single-key shortcut (`V/1 H 2 3 4 5 6 7 8 9`, plus `R O L A P D T E`).
- **Rich styling:** stroke & background color palettes (with custom picker), hachure / cross-hatch / solid fills, three stroke widths, solid / dashed / dotted strokes, sharp or round edges, font size, and opacity.
- **Editing:** multi-select (marquee or shift-click), move, 8-handle resize, duplicate (Ctrl+D), copy/paste, layer ordering, and delete. Hold Shift while drawing to constrain to squares / 45° lines.
- **Undo / redo**, autosave, light & dark themes, PNG export, and per-drawing JSON backups.

## Keyboard shortcuts

| Action                 | Shortcut                                                    |
| ---------------------- | ----------------------------------------------------------- |
| Select / Hand          | `V` · `H`                                                   |
| Shapes                 | `R` rect · `D` diamond · `O` ellipse · `A` arrow · `L` line |
| Draw / Text / Eraser   | `P` · `T` · `E`                                             |
| Undo / Redo            | `Ctrl+Z` · `Ctrl+Shift+Z` / `Ctrl+Y`                        |
| Duplicate / Select all | `Ctrl+D` · `Ctrl+A`                                         |
| Delete                 | `Delete` / `Backspace`                                      |
| Zoom in / out / reset  | `Ctrl +` · `Ctrl -` · `Ctrl 0`                              |

## Run Locally

Serve the folder with any static server:

```bash
python -m http.server 4173 --bind 127.0.0.1
```

Then open `http://127.0.0.1:4173`.

## Local-First Storage

- Drawing sessions live in IndexedDB under `dreamydraw-db`.
- Users can export one drawing or back up all sessions as `.drmdr` JSON files.
- Clearing browser site data removes local drawings, so backups are intentionally built into the first version.

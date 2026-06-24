# Plan: Straßen-Fahrgefühl im BeamNG-Export verbessern (Road-Mask + echte Straßenhöhe)

Status: Analyse & Plan, **keine Implementierung**. Stand 2026-06-21.

## 0. Problem (präzisiert)

Felix' Wunsch: "Gefühl, als würde man auf der Straße fahren." Aktuell nur ein **fixer
z-Offset-Slider**, der nicht sauber auf die echte Straße mappt; Google-Tiles direkt als
Mesh wären uneben, mit Löchern und Glitches.

### Was der Code tatsächlich macht (verifiziert)

| Komponente | Realität im Code | Beleg |
|---|---|---|
| Fahr-/Kollisionsfläche | `.ter` TerrainBlock-Höhenkarte aus **Elevation-API** (Terrarium/USGS/GPXZ), ~2 m/px | `exportBeamNGLevel.js:4853`, `routeTerrainComposite.js:36`, `exportTer.js:17` |
| Google 3D-Tiles | `TSStatic`, **`collisionType:'None'`** → rein visuell, man fährt nie darauf | `exportBeamNGLevel.js:4864` |
| Straßen | bereits `MeshRoad`-Ribbon aus OSM-Centerlines, Z = Terrainhöhe + fixe 0,5 m | `generateMeshRoads` `exportBeamNGLevel.js:2418`, `MESH_ROAD_SURFACE_LIFT` `junctionGeometry.js:5` |
| Höhensampling | bilinear aus heightMap | `getTerrainHeightWorld` `exportBeamNGLevel.js:3085` |
| "Fixer Slider" | `zOffsetM`, verschiebt **nur die visuellen Tiles** | `RouteControlPanel.vue:141` → `exportRouteLevel.js:404` |
| Ground-Stripping | fast-horizontale Google-Tris < 2,5 m über Terrain werden **verworfen** | `stripGroundTris` `googleBakeCore.js:1179` |
| Road-PNG | Terrain-Textur (Hybrid Sat+OSM bzw. OSM); reine Straßen-Overlay-Funktion existiert | `osmTexture.js:1754`, `renderRoadOverlayOnCanvas:1858` |
| Road-Maske (Raster) | bereits vorhanden für Junction-Gaps, world→pixel-Transform vorhanden | `junctionRaster.js` (`rasterizeReferenceMask:121`) |
| Höhenkarten-Glättung/Lochfüllung | Box-Blur (nur bei grobem GPXZ) + Push-Pull-Inpaint (immer) | `resamplerWorker.js:643`, `:657` |

### Kernursache

Die Fahrfläche ist die **grobe, separat berechnete Elevation-Höhenkarte**, die NICHT der
sichtbaren Google-Straße folgt (Versatz, keine Wölbung/Querneigung/Gefälle der echten
Fahrbahn). Der einzige Korrekturhebel ist ein **globaler Konstant-Offset** (`zOffsetM`) –
deshalb "mappt nicht richtig". Gleichzeitig wird die **echte Straßenoberfläche** (die
near-horizontalen Google-Tris) beim Ground-Stripping **weggeworfen**.

> Daraus folgt: Beide von Felix genannten Ideen behandeln Symptome auf der **Textur**-/
> Mask-Ebene. Der mit Abstand größte Gewinn fürs *Fahrgefühl* (= Geometrie) entsteht, wenn
> man die Maske auf die **Höhenkarte** anwendet und die ohnehin schon vorhandene echte
> Straßenhöhe (Google-Ground-Tris) hineinbäckt, statt sie zu verwerfen.

---

## 1. Gemeinsame Bausteine, die beide Ansätze brauchen

1. **Terrain-ausgerichtete Straßenmaske.** Reine Straßen (kein Gebäude/Landuse) als
   Binär-/Distanz-Raster im **exakten** Koordinaten-/Pixelraum der Composite-Höhenkarte
   (`bounds`, `width`, `height` aus `terrainData`). Bausteine existieren:
   - `renderRoadOverlayOnCanvas` (`osmTexture.js:1858`) rendert nur `type==='road'`.
   - `junctionRaster.js` hat bereits world→pixel-Transform + `paintPolyline` mit Halbbreite.
   - Empfehlung: kleine neue Funktion `buildRoadMask(terrainData, {featherM})`, die OSM-Roads
     in Terrain-Pixelraum mit `HIGHWAY_STYLE`-Breite rastert und eine **Feather-/Distanz-
     randzone** (z. B. 2–4 m) für weiches Blending liefert.

2. **Echte Straßenhöhe ("Road-DEM").** Pro Straßen-Pixel eine Zielhöhe. Quelloptionen:
   - **(bevorzugt) Google-Ground-Tris**: die in `stripGroundTris` (`googleBakeCore.js:1179`)
     gefilterten near-horizontalen Tris **vor dem Verwerfen** abgreifen und ihr Z in ein
     Höhenraster splatten (innerhalb der Maske). Das ist die reale Fahrbahnoberfläche inkl.
     Wölbung/Gefälle, deckungsgleich mit den Visuals.
   - **(Fallback) MeshRoad-Centerline-Höhen**: vorhandene Profil-/Elevation-Werte entlang
     der Centerline, quer über die Fahrbahnbreite interpoliert, geglättet.

Diese beiden Bausteine sind die eigentliche Arbeit; die "zwei Ansätze" unterscheiden sich
nur darin, *worauf* man sie anwendet.

---

## 2. Ansatz A — Maske + echte Höhe in die Fahrfläche backen (Geometrie)

**Idee:** In den maskierten Straßenbereichen die Composite-Höhenkarte durch die echte
Straßenhöhe ersetzen/angleichen, mit gefeatherten Rändern, dann lokal glätten/Löcher füllen.
MeshRoad folgt dann automatisch (Z = Terrainhöhe + Lift), und Fahrfläche == sichtbare Straße.

### Eingriffsstellen
- `googleBakeCore.js:1179` (`stripGroundTris`): Ground-Tris zusätzlich in einen
  **Road-Height-Accumulator** (Z-Splat + Counts in Terrain-Pixelraster) schreiben, statt nur
  zu verwerfen. Optionaler Output neben dem gestrippten Mesh.
- Neues Modul `roadHeightConditioning.js`: nimmt `terrainData.heightMap`, Road-Maske,
  Road-DEM → schreibt geblendete Höhen zurück:
  `h' = lerp(hTerrain, hRoad, maskWeight)`, danach kleiner Box-Blur **nur** in Maske
  (Glättung vorhanden in `resamplerWorker.js:643`), Inpaint für DEM-Löcher
  (`pushPullInpaint` `resamplerWorker.js:657`).
- Aufruf in `routeTerrainComposite.js` nach `buildCombinedRouteTerrain` (Zeile ~92), bzw.
  im Single-Tile-Pfad nach `fetchTerrainData`, **vor** `exportTer`.
- `MESH_ROAD_SURFACE_LIFT` (`junctionGeometry.js:5`): reduzieren/0, da die Fläche jetzt passt.
- `zOffsetM`-Slider: bleibt als Feinjustierung, Default → ~0; Bedeutungswechsel von
  "globaler Höhenhack" zu "optionaler Bias".

### Vorteile
- Behebt das **Fahrgefühl** direkt (Geometrie folgt echter Fahrbahn: Wölbung, Gefälle,
  Querneigung). Genau das, was Felix will.
- Macht den fixen Slider überflüssig (ortsabhängige statt konstanter Korrektur).
- Nutzt **bereits berechnete** Daten (Ground-Tris), die heute weggeworfen werden → kaum
  zusätzliche Quelle/Latenz.
- Visual passt automatisch: Google-Ground in Straßenbereichen wird ohnehin gestrippt; man
  sieht das Terrain mit Hybrid-Textur, das nun deckungsgleich liegt → kein Floating/Z-Fight.

### Nachteile / Risiken
- Höhenkarten-Auflösung ~2 m/px ist grob; schmale Residential-Straßen (8 m gesamt) sind nur
  ~4 px breit → ggf. lokal feineres Raster nötig oder MeshRoad bleibt führend.
- Ground-Tris können selbst Glitches/Ausreißer haben → Robustheit: Median/Perzentil pro
  Pixel, Ausreißer-Clamp gegen Centerline-Profil.
- Maske/DEM müssen **pixelgenau** zur `.ter`-Höhenkarte ausgerichtet sein (Off-by-one →
  Stufen am Fahrbahnrand). Transform-Reuse aus `junctionRaster` minimiert Risiko.
- Brücken/Tunnel/Überführungen: DEM ist 2,5D, mehrlagig nicht abbildbar (gleiches Limit wie
  heute).

---

## 3. Ansatz B — Google-Textur in maskierte Straßenbereiche nach unten projizieren (Optik)

**Idee (Felix):** Wo Google-Tiles über dem Höhenprofil liegen UND laut Maske Straße ist, die
Tile-Textur planar nach unten auf die Road/Terrain projizieren; Gebäude (legitim über
Ground) bleiben 3D. In BeamNG-Begriffen: keine echte Laufzeit-Projektion, sondern
**Bake-Zeit**: photoreale Fahrbahntextur aus Google-Sat/Tiles erzeugen und der
Terrain-/MeshRoad-/DecalRoad-Material in Maskenbereichen zuweisen.

### Eingriffsstellen
- `osmTexture.js` (`generateHybridTexture:1806`): in Maskenbereichen Sat-/Tile-Pixel
  bevorzugen statt OSM-Grau; existiert in Ansätzen schon (Hybrid).
- Material-Zuweisung MeshRoad/DecalRoad (`exportBeamNGLevel.js` ~`2536`/`1595`) bzw.
  `terrain.png`-Material (`:5132`).

### Vorteile
- Photorealistischer Straßenlook ohne bumpy Google-Mesh.
- Gebäude bleiben dank Maske unberührt.

### Nachteile / Risiken
- **Verbessert das Fahrgefühl NICHT** — rein kosmetisch. Die Geometrie (Fahrfläche) bleibt
  unverändert grob/versetzt, solange nicht zusätzlich A gemacht wird.
- Vertikale Flächen (Bordsteine, Fahrzeuge, Schilder in den Tiles) verschmieren bei
  Top-Down-Projektion → Maske muss eng sein.
- Doppelter Look-Konflikt mit verbleibendem Google-Visual-Mesh am Maskenrand.

---

## 4. Empfehlung

**Ansatz A umsetzen (Geometrie), B als optionales späteres Texture-Polish.**

Begründung: Felix' explizites Ziel ist das **Fahrgefühl** = Geometrie. Nur A adressiert das.
B allein lässt die Fahrt unverändert holprig. A nutzt zudem Daten, die heute schon berechnet
und dann verworfen werden (Google-Ground-Tris), und entwertet den problematischen Konstant-
Slider zugunsten einer ortsabhängigen, datengetriebenen Korrektur. Die Optik in Straßen-
bereichen ist durch Ground-Stripping + Hybrid-Textur bereits weitgehend gelöst; nach A liegt
diese Textur dann auch geometrisch deckungsgleich.

### Empfohlene Reihenfolge (inkrementell, je verifizierbar)
1. `buildRoadMask(terrainData)` im Terrain-Pixelraum (Reuse `junctionRaster`-Transform +
   `HIGHWAY_STYLE`-Breiten). Debug-PNG-Export zum Sichtprüfen der Ausrichtung.
2. Ground-Tris in `stripGroundTris` zusätzlich als Road-DEM-Raster abgreifen (Z-Splat +
   Median/Count, Inpaint). Debug-Heightmap exportieren.
3. `roadHeightConditioning`: DEM gefeathert in `heightMap` blenden + lokal glätten; danach
   `MESH_ROAD_SURFACE_LIFT` reduzieren. Hart auf Centerline-Profil clampen (Ausreißerschutz).
4. `zOffsetM`-Default 0, Slider als Feinjustierung umlabeln.
5. (optional, später) B: Hybrid-Textur in Maskenbereichen auf Sat/Tile umstellen.

### Offene Fragen vor dem Bauen
- Soll die Fahrfläche **exakt** der Google-Straße folgen (max. Realismus, aber Glitch-Risiko)
  oder die Centerline-/Profilhöhe nur **glätten** (robuster, weniger Detail)? → Blend-Gewicht.
- Feinraster nur für Straßen (z. B. separater höher aufgelöster Road-DEM) vs. globale
  Terrain-Auflösung anheben (teurer Bake)?
- Verhalten an Kreuzungen/Junction-Polygonen (`junctionRaster`-Output) beim Höhen-Blend.
```

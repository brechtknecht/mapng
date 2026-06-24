# Plan: Google-Tiles an die Terrain-"Floor" angleichen (Conform statt Konstant-Offset)

Status: Optionen & Empfehlung, **keine Implementierung**. Stand 2026-06-21.
Folgt auf `plan-road-mask-drive-surface.md`. Ansatz B (Textur-Projektion) ist verworfen.

## 0. Ziel

Die **visuellen Google-Tiles** sollen auf der **Fahrfläche aus dem Elevation-Datensatz**
(`.ter`-Höhenkarte) liegen, statt davon wegzudriften. Optik == Fahrfläche, ohne dass man
auf den bumpy Tiles fährt (Tiles bleiben `collisionType:'None'`, Fahren weiterhin auf `.ter`).

## 1. Warum der Konstant-Offset nicht "mappt" (verifizierte Ursache)

Tile-Vertex-Höhe entsteht in `createTileMeshTransformer` (`googleBakeCore.js:764`):

```js
const beamZMeters = (groundOffset - minH) + cart.height;   // cart.height = WGS84-ellipsoidale Höhe
```

- `cart.height` ist **ellipsoidale** Höhe (WGS84). Die DEM ist oft **orthometrisch (Geoid/EGM)**
  → konstanter Datum-Versatz (zig Meter), lokal nahezu konstant.
- `groundOffset` wird aus **EINEM** Referenzpunkt bestimmt (`probeGroundAltitude`,
  5. Perzentil nahe AOI-Zentrum, `:395`) vs. Terrain bei Scene-`[0,0]`
  (`googleBakeCore.js:717` `mapngGroundY - googleGroundAlt`).
- Platzierung ist ein **starrer Translate**: `position[2] = baseUp + zOffsetM`
  (`exportRouteLevel.js:404`), **keine** Per-Vertex-Anpassung. `zOffsetM` default 0.

**Konsequenz:** Ein einzelner Anker hebt die Tiles nur an EINEM Punkt korrekt auf die DEM.
Überall sonst bleibt die Differenz `tileGround(x,z) − terrain(x,z)` stehen — sie variiert
**räumlich** (Geländeform der Tiles ≠ DEM-Form, plus langsam variierende Geoidwelle).
Genau diese ortsabhängige Differenz kann ein **globaler** Slider prinzipiell nicht beheben.

## 2. Schlüssel-Enabler (macht Conforming billig)

Das Terrain ist im Tile-Koordinatenraum **bereits per-Vertex samplebar**:
`sampleHeightAtScene(data, x, z)` (`googleBakeCore.js:16`) — bilinear aus `heightMap`,
Scene XZ ∈ [−50,50] → Pixel. In `stripGroundTris` (`:1197`) wird sogar schon
`a = vertexY − (sampleHeightAtScene(...) − minH)` berechnet = **Höhe des Vertex über Terrain**.
Heißt: Sowohl "Terrain an Vertex" als auch "Tile-Boden" sind im selben Scope verfügbar.
Conforming = Per-Vertex-Y im selben Loop wie `:764` modifizieren.

---

## 3. Strategien

### S1 — Voller Drape (jeden Vertex-Y aufs Terrain snappen)
`beamZMeters = sampleHeightAtScene(data, sceneX, sceneZ)`.
- **Pro:** Perfekt deckungsgleich mit Fahrfläche; trivial.
- **Contra:** **Plattet ALLES** — Gebäude, Bäume, Brücken kollabieren auf Bodenhöhe.
  Nur brauchbar, wenn man ausschließlich Boden-Tiles behält. **Disqualifiziert** als Gesamt-
  lösung.
- **Eingriff:** `googleBakeCore.js:764`. Aufwand: minimal. **Nur** sinnvoll auf die
  Boden-Tris (siehe S6-Maskenteil).

### S2 — Delta-Field-Conform (additiver, geglätteter Per-Vertex-Versatz) ★ Kern-Empfehlung
1. Beim Mesh-Durchlauf die **near-horizontalen Boden-Tris** (die `stripGroundTris` ohnehin
   erkennt, `:1197`) abgreifen und ihr `cart.height`-basiertes Y in ein **Tile-Ground-Raster**
   `G(x,z)` splatten (Median/Perzentil pro Zelle, Inpaint für Lücken).
2. Delta-Feld `D(x,z) = terrain(x,z) − G(x,z)` bilden, **stark glätten** (low-frequency).
3. Jeden Vertex-Y additiv korrigieren: `beamZMeters += sampleDelta(D, sceneX, sceneZ)`.
- **Pro:** Behebt **ortsabhängige** Differenz (Datum + Geländeform-Unterschied), **erhält
  relative Struktur** (Gebäude bleiben hoch, weil alle ihre Vertices denselben lokalen
  Offset bekommen). Genau "Tiles auf die Floor mappen", ohne zu plätten.
- **Contra:** Braucht Boden-Tile-Sammlung + Glättung; Brücken/Überführungen folgen fälschlich
  der Bodendelta (selten, lokal). Raster-Auflösung wählen.
- **Eingriff:** Boden-Raster in `transformMesh`/`stripGroundTris`-Nähe (`googleBakeCore.js`
  ~750–1210); neues `tileGroundDelta.js`; Korrektur an `:764`. **2-Pass** über das Mesh
  (Pass 1: Boden sammeln → D bauen; Pass 2: Vertices anwenden) oder Boden vorab aus dem schon
  geladenen Mesh. Aufwand: mittel.

### S3 — Höhen-gewichteter Drape (Blend nach Bodennähe)
`w = clamp(1 − aboveTerrain / H)`, `Y' = lerp(Y, terrainY, w)`. Bodennahe Vertices snappen,
hohe behalten Ellipsoidform.
- **Pro:** Kein separater Boden-Raster nötig; nutzt vorhandenes `aboveTerrain`.
- **Contra:** Verzerrt Gebäudefüße/Böschungen (Vertices nahe Boden werden verschoben,
  Dach nicht → Scherung); Schwelle `H` heikel.
- **Eingriff:** `googleBakeCore.js:1197` (Delta vorhanden) → in `:764` anwenden. Aufwand:
  gering. Eher Quick-Win als saubere Lösung; **S2 ist die saubere Variante davon**.

### S4 — Best-Fit-Ebene / Datum-Korrektur (billiger erster Schritt)
Statt 1-Punkt-Anker (`probeGroundAltitude`) viele Bodenpunkte sammeln und `tileGround` gegen
`terrain` als **Ebene (Offset + 2 Neigungen)** least-squares fitten; diese Ebene als Per-Vertex-
Korrektur. Optional echte **EGM-Geoid-Undulation** statt Konstante.
- **Pro:** Entfernt Bulk-Versatz + linearen Trend (oft 80–90 % des Problems) bei sehr kleinem
  Aufwand; robust, keine high-freq-Artefakte.
- **Contra:** Residuale Geländeform-Differenz bleibt. Reicht ggf. nicht für "perfektes" Mapping.
- **Eingriff:** `probeGroundAltitude` (`:395`) → Punktwolke + Fit; `groundOffset`-Berechnung
  (`:717`) durch Ebene ersetzen. Aufwand: gering–mittel. **Guter Schritt 1, dann S2 als
  Verfeinerung.**

### S5 — Inverse: Terrain lokal an Tile-Straßenhöhe anpassen (= Ansatz A, Maske)
Statt Tiles bewegen → Fahrfläche an die echte Straße der Tiles anpassen (in Straßen-Maske),
aus `plan-road-mask-drive-surface.md`.
- **Pro:** Maximaler Fahrrealismus (echte Wölbung/Gefälle als Kollision); Tiles bleiben
  unangetastet.
- **Contra:** Ändert die Fahrfläche/`.ter`; löst NICHT das Off-Road-Drift der Tiles (nur
  Straße). Felix' jetzige Frage zielt auf die **gesamte Tile-Optik**, nicht nur Straße.
- **Eingriff:** `routeTerrainComposite.js` nach `:92`, neues `roadHeightConditioning.js`.

### S6 — Hybrid (empfohlener Gesamtweg)
- **Tile-Optik global:** S2 (Delta-Field) → alle Tiles sitzen sauber auf der Floor, Optik ==
  Fahrfläche überall, Struktur erhalten.
- **Straße exakt (optional, später):** S5 in der Straßen-Maske → Fahrfläche bekommt echte
  Fahrbahnform; weil Tiles via S2 schon auf der Floor liegen, bleibt die Straßenoptik
  deckungsgleich.
- **Slider:** `zOffsetM` wird zur reinen Feinjustierung (Default 0), nicht mehr Hauptkorrektur.

---

## 4. Bewertung

| Strategie | Behebt Konstant-Versatz | Behebt orts-/formabh. Drift | Erhält Gebäude | Aufwand |
|---|---|---|---|---|
| S1 Voller Drape | ✓ | ✓ | ✗ (plattet) | minimal |
| **S2 Delta-Field** | ✓ | ✓ | ✓ | mittel |
| S3 Höhen-Blend | ✓ | ✓ | teilweise (Scherung) | gering |
| S4 Best-Fit-Ebene | ✓ | teilweise (linear) | ✓ | gering |
| S5 Terrain↔Maske | n/a (nur Straße) | nur Straße | ✓ | mittel |
| S6 Hybrid (S2+S5) | ✓ | ✓ | ✓ | mittel+ |

## 5. Empfehlung

1. **Schritt 1 — S4 (Best-Fit-Ebene):** ersetzt den 1-Punkt-Anker, holt mit wenig Code den
   Großteil des Versatzes (inkl. linearer Neigung) raus. Sofort messbar/verifizierbar.
2. **Schritt 2 — S2 (Delta-Field-Conform):** residuale Geländeform-Differenz per geglättetem
   Per-Vertex-Offset eliminieren; Gebäude bleiben erhalten. Das ist das eigentliche
   "Tiles auf die Floor mappen".
3. **Schritt 3 (optional) — S5:** Fahrbahnform in der Maske ins `.ter` backen, falls die
   2 m/px-Floor fürs Fahrgefühl zu grob ist.

Begründung: S4→S2 löst Felix' Anliegen direkt (Optik konsistent zur vorhandenen Floor), nutzt
ausschließlich **schon vorhandene** Daten/Funktionen (`sampleHeightAtScene`, Boden-Tri-
Erkennung) und lässt die Fahrfläche unangetastet — geringes Risiko, klar inkrementell.

## 6. Verifizierte Eingriffsstellen

| Zweck | Datei:Zeile |
|---|---|
| Vertex-Y-Formel (Conform-Hook) | `googleBakeCore.js:764` |
| Terrain-Sampling in Scene-Koord. | `googleBakeCore.js:16` |
| Per-Vertex Höhe-über-Terrain (Delta vorhanden) | `googleBakeCore.js:1197` |
| 1-Punkt-Anker (→ Best-Fit ersetzen) | `googleBakeCore.js:395`, `:717` |
| Boden-Tri-Erkennung (→ Boden-Raster abgreifen) | `googleBakeCore.js:1179` |
| Starre TSStatic-Platzierung / `zOffsetM` | `exportRouteLevel.js:404` |
| Route-weiter Shared-Anker / `baseUp` | `exportRouteLevel.js:292`, `:305` |
| Slider-UI | `RouteControlPanel.vue:141` |

## 7. Implementierungsplan S2 (umgesetzt)

**Erkenntnis:** Die Soup-Passes (`weldSeams` → `stripGroundTris`) laufen bereits auf
assemblierten Positionen `[sceneX, Ymeter-über-.ter-Datum, sceneZ]`. Der Per-Vertex-Delta
`aboveTerrain = Y − (sampleHeightAtScene(data,x,z) − minH)` ist daraus direkt berechenbar
(genau das, was `stripGroundTris` `googleBakeCore.js:1197` schon tut). S2 ist damit ein
**zusätzlicher Soup-Pass** zwischen Weld und Ground-Strip — kein Eingriff in die
ECEF-Transform nötig.

**Neue Module (fokussiert, DOM-frei, testbar):**
- `services/scalarFieldGrid.js` — generisches 2D-Skalarfeld über Scene-XZ:
  `createScalarFieldGrid({cellM, data})` → `.add(x,z,v)`, `.build({inpaint, smoothPasses})`
  → `{ sample(x,z), … }`. Pro Zelle Median; Lücken-Inpaint (nächste gefüllte Zelle, iterativ);
  Box-Blur-Glättung; bilineares Sampling mit Clamp.
- `services/tileGroundConform.js` — `conformTilesToFloor(soup, data, opts)`:
  Pass 1 klassifiziert Boden-Tris (gleiches Distanz+Normalen-Kriterium wie `stripGroundTris`)
  und splattet `aboveTerrain` ins Feld; `build()`; Pass 2 verschiebt **jeden** Vertex
  `Y -= D.sample(x,z)` (geclamped auf `maxShiftM`). Rückgabe wie `weldSeams`
  (`{positions, vertsMoved, meshesMoved}`). Gebäude bleiben erhalten, weil alle ihre Vertices
  denselben lokalen Offset bekommen.

**Eingriffsstellen (minimal):**
- `services/google3dTiles.js` — Import + `conformTilesEnabled()`; Conform-Block nach dem Weld
  (~Z.409), vor dem Ground-Strip (~Z.414).
- `scripts/googleBakeWorker.mjs` — `applyConform(session)` analog zu `applyWeld`, aufgerufen
  nach `applyWeld` an beiden Assembly-Stellen (Z.816–818 & 946–948); Flag `MAPNG_CONFORM_TILES`.

**Verifikation:**
- `node --test tests/scalarFieldGrid.test.mjs tests/tileGroundConform.test.mjs` (synthetisch:
  Boden auf rampenförmigem Versatz + "Gebäude"-Säule → Boden landet auf Terrain, Gebäude
  behält relative Höhe).
- `npm run build` grün.
- Laufzeit-Log: gefüllte Zellen, verschobene Vertices, mittleres |aboveTerrain| Boden vor/nach
  (muss → ~0 gehen). Kein Screenshot nötig (siehe Memory).

## 8. Offene Fragen

- Geoid: lohnt echte EGM-Undulation, oder reicht Best-Fit-Ebene (Undulation über einen Chunk
  ~konstant)? → vermutlich Ebene ausreichend.
- Delta-Raster-Auflösung & Glättungsradius (Trade-off: Artefakte vs. Detailtreue).
- Brücken/Überführungen: Sonderbehandlung nötig oder als akzeptierter Edge-Case (selten)?
- Single-Tile- vs. Route-Pfad: Conform muss in beiden greifen (gleicher `bakeGoogle3DTiles`-Kern,
  daher zentral lösbar).

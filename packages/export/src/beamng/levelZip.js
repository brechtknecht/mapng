/** @layer core */
// Level-archive serialization helpers: NDJSON encoding, recursive SimGroup
// folder/items.level.json writing, and road-folder name sanitization/grouping.
// Extracted verbatim from exportBeamNGLevel.js (06 step 9).

/**
 * Write a newline-delimited JSON (NDJSON) string from an array of objects.
 * Each object is one line, file ends with a newline — matching BeamNG's format.
 */
export function toNDJSON(objects) {
  return objects
    .map((o) => {
      const { __items, ...rest } = o;
      return JSON.stringify(rest);
    })
    .join('\n') + '\n';
}

export function writeSimGroupTree(zip, folderPath, items) {
  if (!Array.isArray(items) || items.length === 0) {
    zip.file(`${folderPath}/items.level.json`, '');
    return;
  }

  zip.file(`${folderPath}/items.level.json`, toNDJSON(items));

  for (const item of items) {
    if (item.class !== 'SimGroup') continue;
    if (!item.name) continue;
    if (!Array.isArray(item.__items)) continue;

    const childFolderPath = `${folderPath}/${item.name}`;
    zip.folder(childFolderPath);
    writeSimGroupTree(zip, childFolderPath, item.__items);
  }
}

export function sanitizeRoadFolderName(value, fallback) {
  const ascii = String(value || '')
    .normalize('NFKD')
    .replace(/[^\x00-\x7F]/g, '');
  const cleaned = ascii
    .replace(/[^A-Za-z0-9 _.-]/g, '_')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, 96);
  return cleaned || fallback;
}

/**
 * Build road group folder metadata from a Road Architect session.
 */
export function buildRoadFolderGroups(roadArchitectSession) {
  const placedGroups = Array.isArray(roadArchitectSession?.data?.placedGroups)
    ? roadArchitectSession.data.placedGroups
    : [];
  if (placedGroups.length > 0) {
    return placedGroups.map((group, index) => ({
      groupName: sanitizeRoadFolderName(group?.name, `road_${index + 1}`),
    }));
  }

  const roads = Array.isArray(roadArchitectSession?.data?.roads)
    ? roadArchitectSession.data.roads
    : [];
  if (roads.length === 0) return [];

  const usedNames = new Map();
  const groups = [];

  for (let i = 0; i < roads.length; i++) {
    const road = roads[i];
    const displayName = sanitizeRoadFolderName(road?.displayName, `road_${i + 1}`);
    const used = usedNames.get(displayName) || 0;
    usedNames.set(displayName, used + 1);
    const groupName = used > 0 ? `${displayName}_${used + 1}` : displayName;
    groups.push({ groupName });
  }

  return groups;
}

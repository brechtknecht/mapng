// Resolve the Google tiles credential (VITE_GOOGLE_MAPS_API_KEY) used by the
// route bake/export entry points. Returns '' when unset so callers can show a
// purpose-specific message. import.meta.env is guarded for non-Vite contexts.
export const getTilesApiKey = () =>
    (import.meta.env?.VITE_GOOGLE_MAPS_API_KEY || '');

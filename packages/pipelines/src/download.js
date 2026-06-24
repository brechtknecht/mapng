// Download a zip-export result. Two shapes: the dev zip-sidecar returns a
// same-origin GET `url` that streams straight to disk (no multi-GB heap Blob);
// the prod fallback returns a `blob` we object-URL.
// Lifted verbatim out of App.vue — pure DOM, no Vue/reactivity.
export const downloadExportResult = (result, fallbackName) => {
    const link = document.createElement('a');
    let objectUrl = null;
    if (result.url) {
        link.href = result.url;
    } else {
        objectUrl = URL.createObjectURL(result.blob);
        link.href = objectUrl;
    }
    link.download = result.filename || fallbackName;
    document.body.appendChild(link);
    link.click();
    link.remove();
    if (objectUrl) URL.revokeObjectURL(objectUrl);
};

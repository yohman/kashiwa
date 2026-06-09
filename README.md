# kashiwa

Before pushing to GitHub Pages, regenerate the manifest and browser-safe photo assets:

```bash
node scripts/build-manifest.mjs
```

This refreshes `manifest.json` and `photos-web/` so routes and photos load correctly on Pages.

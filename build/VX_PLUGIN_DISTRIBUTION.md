# VX plugin distribution

The installable plugin is a ZIP with exactly three files at its root:

- `manifest.json`
- the helper named by the manifest
- the interposer named by the manifest

Build the native binaries, staged Official resource, installable ZIP, and provider-independent
`index.json` with:

```sh
npm run vx-plugin:package
```

The generated files are under `release/plugin/` and remain ignored by Git. Select the ZIP from
the app to test a local installation. For remote distribution, upload both files without changing
their names or contents, then set the fixed HTTPS `indexUrl` in
`src/shared/vx-plugin-distribution-config.ts` and rebuild the app.

Use immutable versioned ZIP object names. The index may use a relative package URL, so the same
files work on R2, another object store, or a normal HTTPS website. The application downloads into
a temporary directory, verifies the index metadata and archive SHA-256, validates the embedded
manifest and native files, then atomically activates the plugin. A failed activation restores the
previous installed version.

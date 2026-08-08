# Phase 3 report: WhatsApp conversion and pack planning

Date: 2026-08-08

Status: READY FOR MANUAL ACCEPTANCE

## Implemented flow

- Persist pack name, publisher, and a configurable pack size from 3 to 30.
- Split selected assets into separate static and animated groups while preserving user order.
- Never create a 1–2 sticker tail. The penultimate pack lends only enough stickers to make the
  final pack contain 3, for example 31 → 28 + 3, 32 → 29 + 3, and
  92 → 30 + 30 + 29 + 3.
- Warn instead of creating a pack when a media group has only 1–2 selected stickers.
- Convert stickers to an exact 512×512 transparent WebP canvas with bounded quality attempts.
  Content smaller than 512px is centered without enlargement; larger content is scaled down.
- Enforce static ≤100KB, animated ≤500KB, animation duration ≤10 seconds, and frame duration
  ≥8ms.
- Generate a static 96×96 PNG tray icon ≤50KB from the first sticker in each pack.
- Cache converted stickers by source SHA-256 plus conversion-version key and reuse valid output.
- Show pack previews, static/animated separation, per-pack status, conversion progress, and precise
  conversion errors. No WhatsApp send action is included in this phase.

## Verification

- Pure splitter tests cover 0, 1, 2, 3, 29, 30, 31, 32, 33, 59, 60, 61, and 92 stickers,
  configurable pack sizes, mixed static/animated media, order preservation, warnings, and stable
  pack identifiers.
- Converter tests cover static and animated WebP output, dimensions, frame delays, duration,
  file-size limits, tray icon generation, file permissions, and cache reuse.
- A local-only smoke test used the current 33-item test collection without logging names or paths:

| Media    | Count | Largest output | Longest animation | Tray icon | Invalid output |
| -------- | ----: | -------------: | ----------------: | --------: | -------------: |
| Static   |    15 |           56KB |               n/a |       5KB |              0 |
| Animated |    18 |          496KB |             7.47s |       7KB |              0 |

The optimized cold conversion completed in approximately 6.5 seconds on the development Mac.

## Current risks and boundaries

- Highly complex animated images may still fail the 500KB limit after all bounded compression
  attempts; the pack is marked failed with the source asset name and reason.
- The converter preserves frame order, timing, transparency, and loop metadata, but cannot judge
  the official recommendation that the first animation frame should communicate the full idea.
- Converted cache cleanup is not yet exposed in UI. Cache files are derived and safe to delete.
- Phase 3 prepares legal pack media but does not create or send a native WhatsApp message. Desktop
  adapter integration remains Phase 4.

## References

- WhatsApp official sticker requirements:
  https://github.com/WhatsApp/stickers/blob/main/Android/README.md
- Sharp animated WebP output:
  https://sharp.pixelplumbing.com/api-output/

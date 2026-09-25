# Veto logo kit: Catch

A brass V holding an amber ball that dropped in and cannot fall through. The ball is the request. The V is the rule that caught it. Nothing passed.

## Files

Masters (SVG, transparent background, viewBox set, no fonts or images embedded)

| File | What it is |
| --- | --- |
| catch-mark.svg | Full color mark. Brass V, amber ball with a dark rim. Use on forest or any dark, calm surface. |
| catch-mark-bone.svg | One color mark in bone. Open ring instead of a filled ball. For forest or dark backgrounds. |
| catch-mark-forest.svg | One color mark in forest. Open ring. For bone or light backgrounds. |
| catch-wordmark.svg | Mark plus "Veto" in Fraunces (weight 500), letters converted to outlines. Bone type, full color mark. For dark backgrounds. |
| catch-wordmark-bone.svg | One color lockup in bone with the open ring. For dark backgrounds. |
| catch-wordmark-forest.svg | One color lockup in forest with the open ring. For light backgrounds. |
| catch-app-icon.svg | The mark on the forest rounded square with the thin brass ring, as on the concept board. Corner radius is 23 percent of the side. |

Exports (PNG)

| File | Size | Use |
| --- | --- | --- |
| app-icon-1024.png | 1024 x 1024 | App Store, Play Store and the Expo `icon` field. Full square, no rounding, no ring. The platforms apply their own mask. |
| adaptive-icon-foreground-1024.png | 1024 x 1024 | Android adaptive icon foreground. Transparent. The mark sits inside the central 66 percent safe circle. |
| adaptive-icon-background-1024.png | 1024 x 1024 | Android adaptive icon background. Solid forest. |
| splash-mark-512.png | 512 x 512 | Splash screen mark, transparent. Place on a forest background. |
| web-icon-512.png | 512 x 512 | Website and web manifest icon. Rounded square with transparent corners. |
| favicon-180.png | 180 x 180 | Apple touch icon. Full square, iOS rounds it. |
| favicon-32.png | 32 x 32 | Browser tab. Rounded forest tile with the mark. |

The `build` folder holds the sources used for the PNG exports and the script that outlined the type. It is not part of the shipped kit.

## Colors

| Name | Hex | Where it appears |
| --- | --- | --- |
| Forest | #0F1A16 | Background. The dark surface the brand lives on. |
| Forest lift | #1C2C25 | Top of the app icon gradient only. |
| Bone | #EDE6D6 | Type in the wordmark. The one color mark on dark. |
| Brass | #C9A24D | The V. The thin ring on the app icon. |
| Amber ball | #E3C77E | The ball fill. This is the same lamp glow the app uses for a decision. |
| Ball rim | #7E5E14 | The 2 unit outline around the ball. |

The ball is the only amber element in the whole identity. Keep it that way: nothing else in the app or on the site should use #E3C77E as a fill.

## Geometry

The mark is drawn in a 100 by 100 box. The V runs from (16, 14) down to (50, 80) and up to (84, 14) with a 9 unit stroke, flat ends and a sharp miter at the bottom. The ball is centered at (50, 37.4) with radius 12. In the one color version the ball becomes a ring with a 4.5 unit stroke. Do not redraw the geometry; scale the SVG.

## Minimum size

- Mark: 24 px tall on screen, 8 mm in print. Below that the ball rim disappears.
- Wordmark: 20 px tall on screen (the cap height of the V is then about 14 px), 7 mm in print.
- Favicon: use the supplied 32 px file, not a downscale of the wordmark.

## Clear space

Keep a margin around the mark equal to the diameter of the ball. In the 100 unit box that is 24 units, so a quarter of the mark's height. Nothing else, type included, enters that zone. For the wordmark, use the same margin measured from the ball in the mark.

## Do

- Use the full color mark on forest or on a dark, quiet photo.
- Use the bone version when the background is dark and only one color is allowed.
- Use the forest version on bone, white, or any light background.
- Keep the mark and the wordmark at the fixed proportions in the SVG files.
- Leave the ball as a filled amber circle in color use and as an open ring in one color use.

## Do not

- Never recolor the ball. Not brass, not bone, not white. It is amber or it is an open ring.
- Never place the mark on a busy background, a gradient that fights the ball, or a photo with high detail behind the V.
- Never stretch, skew, rotate, or flip the mark. The V opens upward and the ball rests inside it.
- Never fill the V or add a drop shadow, glow, bevel, or outline to it.
- Never move the ball. It sits where it was caught.
- Never set "Veto" in another typeface next to the mark, and never retype it from a live font in place of the outlined paths in the wordmark file.
- Never add a container, badge, or circle behind the mark other than the supplied app icon tile.
- Never place the color mark on bone or white. Brass on bone is too weak. Use the forest version there.

## Typeface note

The wordmark uses Fraunces at weight 500 with optical size 64 and 0.02 em tracking, converted to outlines. The kit does not depend on the font being installed. If the type ever needs to be reset, use Fraunces from Google Fonts at those settings and re-export.

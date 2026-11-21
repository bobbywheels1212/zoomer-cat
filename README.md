# Zoomer

A mobile-first static site for Zoomer, a wandering slate-gray neighborhood cat with gold eyes. The colors follow his coat, his eyes, and the oak leaves he sits in. Neighbors report sightings with a pin, a photo, a video, or a story. Netlify Forms stores the submissions. A build step turns the verified ones into a public map.

The planned production URL is [https://zoomer-the-cat.netlify.app](https://zoomer-the-cat.netlify.app). That address lives in one place: `siteUrl` in [`site.config.json`](site.config.json).

## Local preview

Requires Node.js 20 or newer.

```bash
npm install
npm run qr
npm run dev
```

Open http://127.0.0.1:4321. The adventures page shows three clearly labeled sample sightings. They are not real reports.

Preview the production empty state:

```bash
ZOMMER_DATA=empty npm run dev
```

Check the same empty path Netlify uses when the token is missing:

```bash
NETLIFY=true npm run build
```

That command exits 0 and writes `dist/data/sightings.json` with `"source": "empty"`.

`npm test` runs the data and build checks. `npm run verify` serves the site and drives the form, map, thank-you state, sample adventures, and empty state in Chrome.

## What gets published

`npm run build` writes the site to `dist/`. Netlify publishes that folder. The build:

1. Copies the static pages and injects `siteUrl` into canonical links and the collar tag.
2. Writes `dist/js/config.js` from `site.config.json` for the maps and the upload limit.
3. Checks that `sighting.html` still contains the Netlify form.
4. Checks that the committed QR code encodes `siteUrl`.
5. Writes `dist/data/sightings.json`.

On Netlify, or whenever `NETLIFY` or `CONTEXT` is set, the adventure list comes from the Netlify API. Sample sightings are never mixed in. If `NETLIFY_API_TOKEN` or `SITE_ID` is missing, or the API request fails, the build still succeeds and the adventures page shows **No adventures yet, be the first to spot Zoomer!**

On a laptop, with those variables unset, the build uses `data/sample-sightings.json`.

## Connect the site to Netlify

1. In Netlify, add a site from this Git repository. Production branch: `main`.
2. Leave the build settings on the values in `netlify.toml`:
   - Build command: `npm run build`
   - Publish directory: `dist`
   - Node: 20
3. Deploy. Netlify detects the form because `dist/sighting.html` contains a static `<form data-netlify="true">`. The form name is `sighting`.
4. Confirm form detection is enabled (Site configuration → Forms). File uploads are part of the same form.

Anything someone submits — name, story, photo, video, and pin — is published on the adventure map after a rebuild. Do not collect secrets in the form.

### (a) Add `NETLIFY_API_TOKEN`

The build reads verified submissions with `GET /api/v1/sites/{SITE_ID}/forms` and `GET /api/v1/forms/{form_id}/submissions`. `SITE_ID` is already present during Netlify builds. Do not commit a token, and do not put one in `netlify.toml`.

1. In Netlify: user menu → User settings → Applications → Personal access tokens → New access token.
2. Name it `Zoomer sightings build`. Copy the token when Netlify shows it.
3. Open this site → Site configuration → Environment variables → Add a variable.
   - Key: `NETLIFY_API_TOKEN`
   - Value: the token
   - Scopes: **Builds**
   - Secret: yes
4. Redeploy so the build can see the variable.

The token is used only by `scripts/build.js`. The browser never receives it. The build refuses to publish if the token string appears in a text file in `dist/`.

### (b) Rebuild when a sighting arrives

New submissions do not edit the live map by themselves. A build hook plus a form notification rebuilds the site so the new pin is fetched and published.

1. Site configuration → Build & deploy → Continuous deployment → Build hooks → Add build hook.
   - Name: `Rebuild when someone sees Zoomer`
   - Branch to build: `main`
2. Copy the hook URL. It looks like `https://api.netlify.com/build_hooks/…`.
3. Site configuration → Forms → Form notifications → Add notification → Outgoing webhook.
   - Event: New form submission
   - Form: `sighting` (this choice appears after the first deploy detects the form)
   - URL: the build hook URL
4. Save, then send a test sighting.

When Netlify starts that build it sets `INCOMING_HOOK_URL` or `INCOMING_HOOK_BODY`. The script waits 5 seconds before listing submissions so the new one is more likely to be visible. A sighting can still miss that first rebuild and show up on the next one. Use Deploys → Trigger deploy if you need to refresh sooner.

Spam submissions are not requested. The verified list is `GET /forms/{form_id}/submissions` (spam is the same path with `?state=spam`, and this build does not call that). A submission flagged `spam` or `state=spam`, or one with the honeypot filled in, is dropped anyway. If a real note lands in spam, mark it verified in the Netlify Forms UI and trigger a deploy.

Photos and videos are downloaded during the build and saved under `/media/sightings/` because the API file URLs are not treated as public. SVG uploads are skipped. If a file cannot be downloaded, the sighting still appears when it has a story or the other file. Original filenames are not kept.

## Change the public URL and the QR code

`siteUrl` in `site.config.json` is the only copy of the public URL. The QR script, the build, the canonical links, and the text on the collar tag all read it.

```bash
# edit siteUrl, then:
npm run qr
```

Commit `site.config.json`, `assets/qr/zoomer-qr.png`, and `assets/qr/zoomer-qr.svg`. The PNG is 1000×1000, charcoal (`#2b2f36`) on white, error correction level H, with a 4-module quiet zone. The SVG `<desc>` stores the URL the image was generated for. The build fails if that description does not match `siteUrl`, so the printed code and the tag text cannot drift.

The QR encodes the site root, not `/sighting.html`. The landing page has the report button.

## Custom domain later

The site does not use a custom domain yet. When you add one:

1. Netlify → Domain management → add the domain and follow the DNS steps. Use the HTTPS URL Netlify provisions.
2. Set `siteUrl` to that `https://` origin.
3. Run `npm run qr`, commit the config and both QR images, and deploy.
4. Reprint the collar tag and scan it.
5. `https://zoomer-the-cat.netlify.app` keeps working as Netlify's default subdomain. Reprint the tag so the code matches the URL you want people to land on.

## Collar tag

Open `/collar-tag.html` or print it from the footer link.

- Tag size: **45 mm × 72 mm**, with a hole for a split ring.
- QR size on that tag: **25.4 mm (1 inch)** square, quiet zone included in the image.
- Words on the tag: **Hi, I'm Zoomer! Scan to report where you saw me.**
- Print at **100% scale**. Turn off "fit to page" and shrink-to-fit.
- Material: a printed epoxy pet tag (aluminum or stainless blank, full-color print under a clear dome) holds a color QR well. A laser-engraved metal tag also works when the modules stay dark on a light ground. Error correction H leaves room for a scratch.
- 45 × 72 mm suits an adult cat collar and is large for a kitten. For a smaller collar, print the QR alone at 25 mm on a round tag about 32 mm across and shorten the words to "I'm Zoomer — scan me".
- Scan the printed tag in daylight and indoors before it goes on the collar.

The high-resolution files are `assets/qr/zoomer-qr.png` and `assets/qr/zoomer-qr.svg`.

## Map starting point

The sighting map opens at the `map` coordinates in `site.config.json`: central Olathe, Kansas (`38.8814`, `-94.8191`, zoom 14). No street address is stored. The `label` is a note for you; it is not shown on the site. Finders can pan anywhere or tap **Use my location**.

## Form fields

| Field | Required | Notes |
| --- | --- | --- |
| `finder-name` | No | Public if provided |
| `seen-at` | Yes | Defaults to the current local time |
| `latitude`, `longitude` | Yes in the browser | Hidden fields written by the pin |
| `photo` | One of photo, video, or story | `image/*`, one file |
| `video` | One of photo, video, or story | `video/*`, one file |
| `story` | One of photo, video, or story | |
| `bot-field` | Must stay empty | Honeypot |

The browser blocks a submission over 8 MiB (`maxUploadBytes`, 8388608) and warns from 6 MiB (`warnUploadBytes`). Netlify's own cap is about 8 MB for the whole submission. JavaScript posts `FormData` to `/` and then shows an in-page thank-you. Without JavaScript the form posts to `/thank-you.html`. Netlify does not enforce the pin or "at least one of photo, video, or story" rules; the build drops submissions that have no usable pin or no story and no saved file.

## Assumptions

1. The production URL is `https://zoomer-the-cat.netlify.app` until `siteUrl` changes. No custom domain is configured in this repo.
2. The QR code encodes that site root. There is not a second URL for the form.
3. The default map center is central Olathe, Kansas (`38.8814`, `-94.8191`, zoom 14). No street address is used. The public pages do not name the city.
4. Owner name, email, phone, and neighborhood are the literal TODO strings on the home page. They are not contact links.
5. The home-page bio is placeholder copy, marked "Placeholder bio".
6. The site is English only.
7. There is no custom backend, account system, or analytics. Netlify Forms is the only data store. The form name is `sighting`.
8. `SITE_ID` comes from Netlify's build environment. `NETLIFY_API_TOKEN` is a personal access token stored as a secret build variable.
9. Verified submissions are listed from `GET /api/v1/forms/{form_id}/submissions`. Spam is a separate `state=spam` query and is not fetched. Rows with a spam flag or a filled honeypot are discarded too.
10. Uploaded images and videos are copied into the deploy at build time. API file URLs are not put on the public page. SVG uploads are skipped. A failed download does not fail the build.
11. A missing token or a failed API call does not fail the build. The adventures page then shows the empty state. Sample sightings are only for local builds, never for a Netlify build with an empty result.
12. A form-submission outgoing webhook pointed at a build hook is how new sightings trigger a rebuild. The build waits 5 seconds when Netlify sets the incoming-hook variables. A note can still miss that first rebuild.
13. The browser blocks uploads above 8 MiB and warns above 6 MiB. Netlify's cap is about 8 MB for the whole request.
14. A pin is required, and at least one of photo, video, or story is required, in the browser. The finder name is optional. `seen-at` defaults to now in the finder's local time and is stored without a timezone. It is displayed in the viewer's local zone.
15. Each file input accepts one file. Netlify Forms allows one file per input.
16. JavaScript is required for the map, the pin, the size check, and the in-page thank-you. The static form remains in the HTML so Netlify can detect it, and its `action` is `/thank-you.html`.
17. **Use my location** uses the browser Geolocation API. If that is blocked, the finder taps the map or types coordinates. Typed coordinates update the same hidden fields.
18. Leaflet 1.9.4 is loaded from jsDelivr with Subresource Integrity. Tiles are the public OpenStreetMap server, with attribution. A busier map should move to a dedicated tile provider.
19. Pins are inline SVG markers. When two sightings share coordinates to 5 decimal places, the map nudges the extra pins so both can be tapped. The stored coordinates are not changed.
20. The gallery is newest first, using `seen-at`, then `created_at`.
21. The QR image is charcoal on white so it scans on a printed or engraved tag and matches the new ink color. It is 1000×1000 pixels, error correction H, quiet zone of 4 modules. The decode test checks that it still reads as the site URL.
22. The suggested collar tag is 45 mm × 72 mm. The QR prints at 25.4 mm. The tag text is "Hi, I'm Zoomer! Scan to report where you saw me."
23. The dev server on 127.0.0.1 mocks `POST /` so the real submit code can be tested. That server is not part of the deploy. It also sends the Content-Security-Policy from `netlify.toml`.
24. `dist/` is generated and gitignored. `sightings.json` is generated at build time and is not committed.
25. Node.js 20 or newer is required (`fetch`, and Netlify's `NODE_VERSION`).
26. Fraunces and Nunito are self-hosted Latin variable fonts under the SIL Open Font License. See `src/fonts/OFL.txt`.
27. Sample adventures are fictional notes clustered around central Olathe, with no street address. They are labeled `[SAMPLE]` and are not shown when a Netlify build has no verified submissions.

## Layout

```
site.config.json          the public URL and map defaults
netlify.toml              build command, publish dir, headers
src/                      pages, CSS, browser scripts, illustrations
data/sample-sightings.json
scripts/build.js          copies the site and writes sightings.json
scripts/sightings.js      Netlify API client
scripts/generate-qr.js    writes assets/qr from siteUrl
scripts/dev-server.js     local static server and form mock
assets/qr/                committed PNG and SVG
```

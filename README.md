# Afterglow Lite (Netlify)

Guests scan a QR code at the venue, upload a photo, and the venue approves it and schedules it through Buffer. This version runs entirely on Netlify, so you can test it from a browser. No terminal is needed after the first setup.

## What's in the folder

- `public/index.html`: the guest upload page (`/?event=EVENT_ID`)
- `public/owner.html`: the owner page (`/owner`), where you review, approve, and send photos
- `netlify/functions/api.mjs`: the one serverless function that handles every API call
- `netlify/functions/lib/app.mjs`: the routes and rules (kids hold, approval, Buffer send)
- `netlify/functions/lib/exif.mjs`: strips GPS and camera metadata from JPEG and PNG
- `netlify/functions/lib/buffer.mjs`: the Buffer GraphQL calls
- `netlify.toml`: routes `/api/*`, `/media/*`, and `/owner` to the right places
- `test/`: 17 automated tests (`npm test`)

## Setting it up in the browser

1. Put the folder on GitHub (create a new repository and upload the files), then connect it at app.netlify.com with "Add new site" → "Import an existing project".
2. In Netlify, go to Site configuration → Environment variables and add:
   - `OWNER_TOKEN`: a long password you choose. You type it into the owner page.
   - `BUFFER_API_KEY` (optional): leave it out to test in dry-run mode. Sends then show the payload instead of posting.
   - `BUFFER_ORG_ID` (optional): only needed if your Buffer account has more than one organization.
3. Deploy the site. Netlify gives you a URL like `https://your-name.netlify.app`.
4. Open `https://your-name.netlify.app/owner`, enter your owner token, and create an event.
5. Open the guest link `https://your-name.netlify.app/?event=EVENT_ID` on your phone and upload a photo.

Photos are stored in Netlify Blobs (events, upload records, and photo files). Nothing is written to the code repository.

## How the rules work

- **Metadata:** Photos are re-encoded in the browser before upload, and the server also strips GPS and EXIF data.
- **Kids:** If the guest ticks "kids in this photo", the photo is held. It can't be approved until a guardian consent is recorded.
- **Public access:** A photo is only publicly reachable once it is approved, sent, or scheduled. Retiring a photo deletes the file.
- **Buffer:** Approved photos become drafts with the photo, caption, and alt text. Scheduling promotes the draft to a post at the chosen time on the chosen channel.

## Known limits

- Netlify function request bodies are capped at about 6 MB. The browser shrinks photos to 2048 px, so this is normally fine.
- Listing uploads reads each record, so it is fine for a test night but would need an index for a busy event.
- Buffer's field names match its reference as of October 2026, but they have not been checked against a live account. Run one dry run and one real send with a test channel before trusting it.
- The Buffer tag limits are still unverified. This build uses no tags.
- QR code generation is not built yet. Print a QR code of the guest link with any free generator.

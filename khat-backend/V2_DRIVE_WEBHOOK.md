# Sending course files from the Google Drive upload portal to Tehseen al-Khat

When someone uploads a course file through the Drive upload portal (Apps Script), the portal can
send it straight to the website. The website reads the **file name** and puts the file in the
right course, level and step by itself:

- a new step number → the step is created
- a new level number → the level is created
- the same name and version again → nothing happens (safe to send twice)
- a higher version (`_v2`) → becomes the file in use; the old one is kept in history

File names follow the usual pattern, for example `FNK-C101_MT_LV01_S01_P01_07_v1.jpg`.
The course (here `FNK-C101`) must already exist — import the Master Course List first.

---

## One-time setup (technical team, 5 minutes)

1. **Choose a secret word** — a long random text, e.g. from https://www.random.org/strings/
   (use 40 letters and numbers).
2. **Add it to the backend** settings (`khat-backend/.env` or the hosting panel):
   ```
   INGEST_WEBHOOK_SECRET=paste-the-secret-here
   ```
   Restart the backend.
3. *(Optional — only for files larger than about 30 MB, e.g. long videos)* give the backend
   read access to Drive, using **one** of:
   - `GOOGLE_API_KEY=...` — works when the folders are shared "Anyone with the link can view";
   - `GOOGLE_SERVICE_ACCOUNT_JSON=...` — the service account key (the JSON text, base64 of it,
     or a path to the file). Share the course folders with the service account e-mail.

   The same settings are used by the **"Import from Drive folder"** button in the course builder.
4. **Add the secret to the Apps Script project** of the upload portal:
   Apps Script editor → ⚙ Project Settings → *Script properties* → **Add script property**
   - `KHAT_WEBHOOK_URL` = `https://<your-backend-address>/v2/ingest/webhook`
   - `KHAT_WEBHOOK_SECRET` = the same secret word as in step 2
5. Paste the code below into the Apps Script project (a new file `khat.gs`) and call
   `sendToKhat(file)` right after the portal saves each uploaded file (see "Where to call it").

---

## Apps Script code (ready to paste)

```javascript
/**
 * Sends one Drive file to Tehseen al-Khat. Safe to call more than once for the same file.
 * @param {GoogleAppsScript.Drive.File} file  the file the portal just saved
 * @return {{ok: boolean, message: string}}
 */
function sendToKhat(file) {
  var props = PropertiesService.getScriptProperties();
  var url = props.getProperty('KHAT_WEBHOOK_URL');
  var secret = props.getProperty('KHAT_WEBHOOK_SECRET');
  if (!url || !secret) return { ok: false, message: 'KHAT_WEBHOOK_URL / KHAT_WEBHOOK_SECRET are not set.' };

  var payload = {
    driveFileId: file.getId(),
    fileName: file.getName(),
    mimeType: file.getMimeType()
  };
  // Files up to ~30 MB are sent with their content, so the server needs no Drive access.
  // Bigger files (videos) are fetched by the server from Drive (needs step 3 of the setup).
  if (file.getSize() <= 30 * 1024 * 1024) {
    payload.contentBase64 = Utilities.base64Encode(file.getBlob().getBytes());
  }

  for (var attempt = 1; attempt <= 3; attempt++) {
    try {
      var res = UrlFetchApp.fetch(url, {
        method: 'post',
        contentType: 'application/json',
        headers: { 'X-Ingest-Secret': secret },
        payload: JSON.stringify(payload),
        muteHttpExceptions: true
      });
      var code = res.getResponseCode();
      var body = {};
      try { body = JSON.parse(res.getContentText()); } catch (e) {}
      var message = body.message || body.error || ('HTTP ' + code);
      if (code === 200) return { ok: true, message: message };      // filed, or already there
      if (code === 422 || code === 400 || code === 401 || code === 503) {
        return { ok: false, message: message };                      // name/setup problem: retrying will not help
      }
    } catch (err) {
      message = String(err);
    }
    Utilities.sleep(2000 * attempt);                                // server busy: wait and retry
  }
  return { ok: false, message: 'Could not reach the website: ' + message };
}

/** Optional: send every file of a folder again (e.g. after fixing names). Already-sent files are skipped. */
function resendFolderToKhat(folderId) {
  var files = DriveApp.getFolderById(folderId).getFiles();
  while (files.hasNext()) {
    var f = files.next();
    var r = sendToKhat(f);
    Logger.log(f.getName() + ' → ' + (r.ok ? 'OK ' : 'NOT FILED ') + r.message);
  }
}
```

### Where to call it

In the portal's upload handler, right after the file is created in Drive:

```javascript
var file = folder.createFile(blob);       // existing portal code
var khat = sendToKhat(file);              // new line
// Optional: show the result to the uploader
// return { ok: true, khat: khat.message };
```

Show `khat.message` to the person uploading — it is written in plain words, e.g.
*"Created step S03 in LV01 (Worksheet) and added the worksheet 0.7 mm, page P01, v1."* or
*"Course FNK-C101 is not in the master list yet — import the master list first."*

---

## What the website answers

| Code | Meaning | What to do |
|------|---------|------------|
| 200 | Filed (or it was already there) | nothing |
| 422 | The file could not be filed — the `message` says why (name not understood, course not in the master list, …) | rename the file in Drive, then run `sendToKhat` again |
| 400 | `driveFileId` / `fileName` missing | check the portal code |
| 401 | Wrong secret | check `KHAT_WEBHOOK_SECRET` matches the backend |
| 503 | Secret not set on the server, or a big file without Drive credentials | finish the setup steps |

Request (JSON, header `X-Ingest-Secret: <secret>`):
`{ "driveFileId": "1AbC…", "fileName": "FNK-C101_MT_LV01_S01_P01_07_v1.jpg", "mimeType": "image/jpeg", "contentBase64": "…optional…" }`

Response: `{ "filename", "ok", "action": "new_level|new_step|add_file|new_version|same_file|unknown_course|error", "stepId?", "fileId?", "message" }`

Every filed upload appears in the course's history in the builder (who: "Automatic").
Sending the same Drive file twice is harmless: the server remembers the Drive file id.

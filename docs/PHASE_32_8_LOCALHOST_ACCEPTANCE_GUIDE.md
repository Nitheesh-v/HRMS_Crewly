# PHASE 32.8 — LOCALHOST ACCEPTANCE GUIDE (Beginner, PowerShell)

Status: guide for **32.8 implemented** (awaiting localhost acceptance).
Everything runs on YOUR machine. No command below reads or prints
secrets. PowerShell only.

---

## 0. WHAT YOU ARE PROVING (plain words)

Phase 32.8 made **employee files private**:

- My Documents, the HR file cabinet (Aadhaar/salary/letters…), expense
  receipts, and task attachments used to be stored as **public**
  Cloudinary objects with permanent public URLs. NEW uploads are now
  **private objects** — the ONLY way to get the bytes is the API's
  authorized download endpoint, which checks WHO you are first.
- Old (pre-32.8) files still download — but now ONLY through the same
  authorized endpoint.

You will upload a safe synthetic file, download it as the owner, prove
a DIFFERENT user cannot download it, and prove oversized/wrong-type
files are refused.

## 1. WHAT YOU NEED

| Thing | Needed? |
|---|---|
| MongoDB | **YES** (normal dev `.env`) |
| Redis + Worker | Only if you also want to re-verify 32.7 — not for these file flows |
| Frontend (Vite) | **YES** (the View buttons now use the gated endpoint) |
| Cloudinary keys | **OPTIONAL** — without them the app uses the DEV inline fallback automatically; with them, files go to Cloudinary as PRIVATE objects |
| Role | One HR/ADMIN account + one ordinary EMPLOYEE account (normal accounts you already have) |

Environment variable NAMES that matter (never print values):
`CLOUDINARY_CLOUD_NAME`, `CLOUDINARY_API_KEY`, `CLOUDINARY_API_SECRET`
(optional), `MAX_RESUME_SIZE_MB`, `MAX_PRE_ONBOARDING_DOC_SIZE_MB`,
`NODE_ENV` (leave unset/development on localhost).

Open **two** PowerShell terminals:

```powershell
cd C:\Users\megal\Desktop\HRMS\HRMS_Crewly\Backend    # Terminal 1
cd C:\Users\megal\Desktop\HRMS\HRMS_Crewly\Frontend   # Terminal 2
```

## 2. START THE APP

Terminal 1 (backend):

```powershell
npm run dev
```

Terminal 2 (frontend):

```powershell
npm run dev
```

Log in in the browser as your ordinary EMPLOYEE account.

## 3. CREATE A SAFE TEST FILE

A harmless synthetic PDF — no personal data:

```powershell
$pdf = "C:\Users\megal\Desktop\test-document.pdf"
"%PDF-1.4`n1 0 obj<</Type/Catalog>>endobj`ntrailer<</Root 1 0 R>>" | Out-File -FilePath $pdf -Encoding ascii
```

(630 bytes, opens as a blank/invalid-but-scannable PDF — perfect for
upload tests. Clean it up at the end: `Remove-Item $pdf`.)

## 4. SAFE UPLOAD TEST (My Documents)

- Frontend → **Documents** (My Documents) page.
- Upload `test-document.pdf` with a name like "Acceptance Test Doc".
- Expected: upload succeeds; the row appears with **View** and
  **Download** buttons (there is no longer any public URL involved).
- Backend log shows no file contents, no URLs, no storage keys.

With Cloudinary configured: your Cloudinary console Media Library will
show the object — its resource type is **Authenticated** (private).
Without Cloudinary: the file lives inline in Mongo (dev fallback) —
the file endpoint still serves it identically.

## 5. AUTHORIZED PRIVATE DOWNLOAD (owner)

- Click **View** / **Download** on the row you just uploaded.
- Expected: the file downloads immediately (a download — private bytes
  have no public tab URL anymore). No errors in backend log.

## 6. UNAUTHORIZED USER TEST (the core 32.8 proof)

- Log OUT. Log in as a DIFFERENT ordinary employee (same company) who
  has NOT been granted anything.
- Open My Documents — the test row is not there (it belongs to the
  first user). Now try the direct endpoint with the first user's
  document id (replace `:id`):

```powershell
$resp = Invoke-WebRequest -Uri "http://localhost:5000/api/documents/:id/file" -Headers @{ Authorization = "Bearer PASTE-SECOND-USER-TOKEN" } -MaximumRedirection 0 -SkipHttpErrorCheck
$resp.StatusCode
```

Expected: **404** ("Document not found" — deliberately identical to a
missing file; no storage details leak). Getting the id alone grants
NOTHING. If you don't want to craft tokens, simply verify in the UI
that the second employee's Documents list never shows the file and
there is no URL to click.

- HR/ADMIN of the same company SHOULD be able to download it (via the
  HR file cabinet View button) — that is the intended rule
  (owner-or-HR).

## 7. LOCAL FALLBACK TEST (only if Cloudinary is NOT configured)

The dev fallback stores bytes inside Mongo (never on disk, never under
a public folder):

- The upload in §4 already used it (backend log said
  "Cloudinary keys missing/invalid — uploads use inline storage").
- There is NO file anywhere under the project to browse and NO public
  URL — the gated endpoint is the only path (§4–6 prove it).
- Production stance (documented, not testable on localhost): with
  `NODE_ENV=production` and no Cloudinary, uploads fail LOUD with 503 —
  the DB never claims a file exists when storage failed.

## 8. MULTI-INSTANCE TEST (optional)

Only if you want to see API #1 upload → API #2 serve:

```powershell
# Terminal 3
cd C:\Users\megal\Desktop\HRMS\HRMS_Crewly\Backend
$env:PORT="5001"
npm run dev
```

Upload via the app (API #1 on :5000), then run the §5 download against
`http://localhost:5001/api/documents/:id/file` with the owner's token —
it works, because delivery depends only on Cloudinary/Mongo, not on the
process that received the upload.

> HONEST CAVEAT: both APIs are on the SAME machine, so this does NOT by
> itself prove multi-host safety — but 32.8 storage never touches
> process-local durable disk at all (provider or Mongo only), which is
> the actual production guarantee. Cleanup the env afterwards:
> `Remove-Item Env:PORT`

## 9. OVERSIZED FILE TEST

My Documents rejects > 5 MB (the middleware cap for that route):

```powershell
$big = "C:\Users\megal\Desktop\too-big.pdf"
fsutil file createnew $big (6MB)
```

Upload `too-big.pdf` on the Documents page → expected: clean refusal
("File too large", HTTP 400). Delete it afterwards:
`Remove-Item $big`.

## 10. INVALID FILE TYPE TEST

```powershell
$bad = "C:\Users\megal\Desktop\bad-type.txt"
"just text" | Out-File $bad -Encoding ascii
```

Rename nothing dangerous — this is a plain text file. Upload as a
document / receipt / task attachment → expected: clean refusal
("File must be a PDF, JPG, JPEG, PNG, or WEBP with a valid type",
HTTP 400). Previously ANY type was accepted — this is the 32.8 fix.

## 11. EXPENSE RECEIPT + TASK ATTACHMENT (same law)

- **Expenses** page: submit an expense with `test-document.pdf` as
  receipt → the row shows a `receipt` button → clicking it downloads
  through the gated endpoint (owner). Another employee sees no button
  for it; HR/Finance CAN download.
- **Tasks**: open a task you can see → attach the test file → the
  attachment name is a download button. A user who cannot see the task
  cannot fetch its attachments (same visibility rule as the task).

## 12. PRODUCT REGRESSION (affected flows only)

- Resume upload (career portal) + HR candidate view — unchanged
  behavior expected.
- Pre-onboarding document upload/replace — unchanged.
- Payslip download (self) — unchanged.
- No payroll payment, BGV terminal decision, or attendance finalization
  as part of this acceptance.

## 13. ACCEPTANCE CHECKLIST (leave UNCHECKED until YOU see it)

- [ ] Backend + frontend start normally.
- [ ] Safe test upload works (My Documents).
- [ ] Owner can download via the View/Download buttons (no public URL anywhere).
- [ ] Different employee CANNOT fetch the file by id (404; UI never offers it).
- [ ] Same-company HR CAN fetch it.
- [ ] Expense receipt + task attachment follow the same rule.
- [ ] Oversized file refused (400).
- [ ] Wrong-type file refused (400).
- [ ] With Cloudinary configured: new objects appear as Authenticated (private) in the Media Library.
- [ ] Backend logs show no file contents / URLs / storage keys.
- [ ] Local fallback (no Cloudinary) works and is dev-only.
- [ ] Resume / pre-onboarding / payslip flows unaffected.
- [ ] No permanent public URL was introduced for any sensitive file.
- [ ] Test files cleaned up (`Remove-Item`).

---

*Phase 32.8 awaiting localhost acceptance.*

"""Contract-shaped fixtures for the frontend-student harness (mocked /v2/* backend)."""
import copy

STEP_TYPES = [
    {"typeKey": "worksheet", "label": "Worksheet", "fileCodes": ["MT", "PW", "WS", "HF"], "studentAction": "watch_download", "feedbackMode": "none", "hasMarks": False, "gatesProgress": False, "awardsBadge": False, "requiresPriorUploads": False, "defaultInstructions": "1. Watch the video.\n2. Look at the reference image.\n3. Download and print the worksheet for your mistar size.\n4. Practise the worksheet, keep it safe for the level assessment, then press \"Mark as done\".", "sortOrder": 10, "isSystem": True},
    {"typeKey": "kitabat", "label": "Kitabat", "fileCodes": ["KT"], "studentAction": "watch_download", "feedbackMode": "none", "hasMarks": False, "gatesProgress": False, "awardsBadge": False, "requiresPriorUploads": False, "defaultInstructions": "Download the page, write it out carefully and press \"Mark as done\".", "sortOrder": 20, "isSystem": True},
    {"typeKey": "istinsakh", "label": "Istinsakh", "fileCodes": ["IS"], "studentAction": "upload", "feedbackMode": "feedback", "hasMarks": False, "gatesProgress": False, "awardsBadge": False, "requiresPriorUploads": False, "defaultInstructions": "Upload one page of your Istinsakh here. Your teacher will reply in this chat.", "sortOrder": 60, "isSystem": True},
    {"typeKey": "assessment", "label": "Level assessment", "fileCodes": ["AW", "AS"], "studentAction": "download_upload", "feedbackMode": "annotate_mark", "hasMarks": True, "gatesProgress": True, "awardsBadge": True, "requiresPriorUploads": True, "defaultInstructions": "1. Download the assessment sheet and write it once, carefully.\n2. Upload the worksheets of every step of this level and the finished assessment sheet.\n3. Your teacher marks the assessment sheet out of 10 and replies here.", "sortOrder": 70, "isSystem": True},
    {"typeKey": "final_submission", "label": "Final submission", "fileCodes": ["FS"], "studentAction": "upload", "feedbackMode": "annotate_mark", "hasMarks": True, "gatesProgress": False, "awardsBadge": True, "requiresPriorUploads": False, "defaultInstructions": "Upload your final work here (photos or one PDF). Your teacher marks it and replies here.", "sortOrder": 80, "isSystem": True},
]

_fid = [0]


def f(role, size=None, page="P01", name="file"):
    _fid[0] += 1
    i = _fid[0]
    ct = "video/mp4" if role == "video" else "image/jpeg"
    return {"id": f"f{i}", "role": role, "sizeCode": size, "page": page, "version": 1, "isCurrent": True,
            "storageKey": f"course-files/{name}-{i}.jpg", "originalFilename": f"{name}.jpg", "canonicalName": f"FNK-C101_{name}_{page}_{size or 'NA'}_v1",
            "contentType": ct, "byteSize": 120000, "source": "upload", "uploadedAt": "2026-11-01T10:00:00Z", "uploadedByName": "Admin"}


def step(sid, lid, code, idx, title, stype, files, message=None):
    return {"id": sid, "levelId": lid, "code": code, "orderIndex": idx, "title": title, "stepType": stype, "template": None,
            "message": message, "maxMarks": 10 if stype == "assessment" else None, "badgeCode": None, "status": "published",
            "source": "file", "files": files, "missing": []}


def level(lid, code, idx, desc, instructions, steps):
    return {"id": lid, "courseId": "c1", "code": code, "orderIndex": idx, "description": desc, "instructions": instructions,
            "badgeCode": None, "status": "published", "steps": steps}


def state(sid, done=False, status=None, mark=None, band=None, attempts=0, unread=0):
    return {"stepId": sid, "done": done, "submissionStatus": status, "mark": mark, "band": band, "attemptsUsed": attempts, "unreadMessages": unread}


LV_INSTR = "1. Look at the video\n2. Download the reference image\n3. Do the worksheet\n4. Upload"

COURSE_C1 = {
    "id": "c1", "code": "FNK-C101", "title": "Naskh Foundations", "titleAr": "أساسيات النسخ", "penType": "normal", "courseType": "certification",
    "khatTypeId": "k1", "status": "published", "structureVersion": 2, "branchIds": [], "mistarSizes": ["10", "20"],
    "counts": {"levels": 4, "steps": 11, "files": 30, "missing": 0, "students": 120}, "updatedAt": "2026-11-01T10:00:00Z",
    "description": "Letters, joins and the rhythm of Naskh — one calm level at a time.", "instructions": None,
    "driveFolderUrl": None, "masterRow": None,
    "levels": [
        level("l1", "LV01", 0, "مفردات", LV_INSTR, [
            step("s11", "l1", "S01", 0, "Alif, baa, taa", "worksheet", [f("video", name="vd"), f("reference", name="rf"), f("worksheet", "10", name="mt"), f("worksheet", "20", name="mt")]),
            step("s12", "l1", "S02", 1, "Jeem family", "kitabat", [f("worksheet", "10", name="kt"), f("worksheet", "20", name="kt")]),
            step("s13", "l1", "S03", 2, "Level 1 assessment", "assessment", [f("assessment_sheet", "10", name="aw"), f("assessment_sheet", "20", name="aw")]),
        ]),
        level("l2", "LV02", 1, "مركبات", LV_INSTR, [
            step("s21", "l2", "S01", 0, "Two-letter joins", "worksheet", [f("video", name="vd"), f("reference", name="rf"), f("reference", name="rf2"), f("worksheet", "10", "P01", name="mt"), f("worksheet", "10", "P02", name="mt"), f("worksheet", "20", "P01", name="mt")]),
            step("s22", "l2", "S02", 1, "Three-letter joins", "worksheet", [f("video", name="vd"), f("worksheet", "10", name="mt"), f("worksheet", "20", name="mt")],
                 message="Take your time with the baa–seen join. Write each line twice before marking it done."),
            step("s23", "l2", "S03", 2, "Istinsakh page", "istinsakh", []),
            step("s24", "l2", "S04", 3, "Level 2 assessment", "assessment", [f("assessment_sheet", "10", name="aw"), f("assessment_sheet", "20", name="aw")]),
        ]),
        level("l3", "LV03", 2, "جمل", None, [
            step("s31", "l3", "S01", 0, "Short phrases", "worksheet", [f("worksheet", "10", name="mt")]),
            step("s32", "l3", "S02", 1, "Level 3 assessment", "assessment", [f("assessment_sheet", "10", name="aw")]),
        ]),
        level("l4", "LV04", 3, "Ayat", None, [
            step("s41", "l4", "S01", 0, "Final ayat", "assessment", [f("assessment_sheet", "10", name="aw")]),
        ]),
    ],
    "enrolled": True, "unlockedLevelIds": ["l1", "l2"], "progressPercent": 45,
    "stepStates": {
        "s11": state("s11", True), "s12": state("s12", True), "s13": state("s13", True, "passed", 9, "distinction", 1),
        "s21": state("s21", True), "s22": state("s22"), "s23": state("s23", False, "submitted", attempts=1),
        "s24": state("s24", False, "revision", 5, "revision", 1, 2),
    },
    "stepTypes": STEP_TYPES,
    "policies": {"print.instructions": "Print on A4 at your branch office or at home. Write your name only where the sheet asks for it.", "print.allow_multi": True,
                 "assessment.bands": {"revisionMax": 5, "passMax": 8}, "uploads.max_files": 20, "student.choose_one_size": True},
    "mySize": "10",
}

COURSE_C2 = copy.deepcopy(COURSE_C1)
COURSE_C2.update({"id": "c2", "code": "FNK-K201", "title": "Thuluth crash course", "titleAr": "دورة الثلث المكثفة", "courseType": "crash", "penType": "cut",
                  "description": "Six focused sheets and one final piece.", "mistarSizes": ["NP"], "progressPercent": 30, "unlockedLevelIds": ["lc"], "mySize": None})
COURSE_C2["levels"] = [level("lc", "LV01", 0, None, None, [
    step("c2s1", "lc", "S01", 0, "Alif and baa", "worksheet", [f("video", name="vd"), f("worksheet", "NP", name="ws")]),
    step("c2s2", "lc", "S02", 1, "Haa family", "worksheet", [f("worksheet", "NP", name="ws"), f("worksheet", "NP", "P02", name="ws")]),
    step("c2s3", "lc", "S03", 2, "Final piece", "final_submission", []),
])]
COURSE_C2["stepStates"] = {"c2s1": state("c2s1", True), "c2s3": state("c2s3", False, "passed", 8, "pass", 1)}

COURSE_NOT_ENROLLED = copy.deepcopy(COURSE_C1)
COURSE_NOT_ENROLLED.update({"enrolled": False, "unlockedLevelIds": ["l1"], "progressPercent": 0, "stepStates": {}})

COURSE_NO_SIZE = copy.deepcopy(COURSE_C1)
COURSE_NO_SIZE.update({"mySize": None})


def summary(cid, code, title, ar, pen, ctype, status="published", levels=4, steps=12, enrolled=None, progress=None):
    d = {"id": cid, "code": code, "title": title, "titleAr": ar, "penType": pen, "courseType": ctype, "khatTypeId": "k", "status": status,
         "structureVersion": 2, "branchIds": [], "mistarSizes": ["10", "20"], "counts": {"levels": levels, "steps": steps, "files": 20, "missing": 0, "students": 40}, "updatedAt": None}
    if enrolled is not None:
        d["enrolled"] = enrolled
        d["progressPercent"] = progress or 0
    return d


COURSE_LIST = [
    summary("c1", "FNK-C101", "Naskh Foundations", "أساسيات النسخ", "normal", "certification", enrolled=True, progress=45),
    summary("c3", "FNK-C102", "Naskh Intermediate", "النسخ المتوسط", "normal", "certification", enrolled=False),
    summary("c4", "FNK-K101", "Naskh in a weekend", None, "normal", "crash", levels=1, steps=6, enrolled=False),
    summary("c5", "FNK-M101", "Mashq — Qasaid", "مشق القصائد", "normal", "mashq", levels=1, steps=9, enrolled=True, progress=80),
    summary("c2", "FNK-K201", "Thuluth crash course", "دورة الثلث المكثفة", "cut", "crash", levels=1, steps=3, enrolled=True, progress=30),
    summary("c6", "FNK-C201", "Thuluth Certification", "شهادة الثلث", "cut", "certification", status="held", enrolled=True, progress=12),
]

EFFECTIVE = {"print.instructions": "Print on A4.", "assessment.max_attempts": 3, "merit.levels_per_point": 3, "merit.certification_points": 10, "merit.monthly_cap": 10}

BADGES = [
    {"id": "b1", "badgeCode": "BDG_FNK-C101_LV01", "kind": "level", "courseId": "c1", "levelId": "l1", "label": "FNK-C101 · LV01 مفردات", "awardedAt": "2026-10-12T10:00:00Z"},
    {"id": "b2", "badgeCode": "BDG_FNK-M101", "kind": "course", "courseId": "c5", "levelId": None, "label": "Mashq Qasaid complete", "awardedAt": "2026-09-30T10:00:00Z"},
    {"id": "b3", "badgeCode": "CMP_ASHARA", "kind": "competition", "courseId": None, "levelId": None, "label": "Ashara decoration — selected", "awardedAt": "2026-08-01T10:00:00Z"},
]


def merit(i, label, pts, month, status, given=None):
    return {"id": f"m{i}", "studentId": "stu-1", "studentName": "Fatema", "trNumber": "TR123", "branchName": "Marol", "source": "levels", "sourceLabel": label,
            "points": pts, "earnedMonth": month, "status": status, "givenByName": "Sh Moiz bhai" if given else None, "givenAt": given}


MERIT = [
    merit(1, "Levels 1–3 of FNK-M101", 1, "2026-11", "pending"),
    merit(2, "Certification FNK-M101", 10, "2026-12", "pending"),
    merit(3, "Levels 1–3 of FNK-C001", 1, "2026-10", "given", "2026-10-28T10:00:00Z"),
    merit(4, "Levels 4–6 of FNK-C001", 1, "2026-09", "given", "2026-09-26T10:00:00Z"),
]

COMPETITIONS = [
    {"id": "k1", "kind": "call", "title": "Ashara 1448 decoration", "description": "Write one excerpt on A3 art paper in Thuluth. Selected pieces will decorate the masjid during Ashara.",
     "branchIds": None, "excerpts": [{"text": "إِنَّ اللَّهَ مَعَ الصَّابِرِينَ", "note": "Excerpt 1"}, {"text": "وَاعْتَصِمُوا بِحَبْلِ اللَّهِ جَمِيعًا", "note": "Excerpt 2"}],
     "coverStorageKey": "competitions/cover-ashara.jpg", "startDate": "2026-11-01", "endDate": "2026-11-30", "status": "open", "resultsPublished": False, "entryCount": 14, "myEntry": None, "selections": []},
    {"id": "k2", "kind": "competition", "title": "Naskh mufradat competition", "description": "Your best page of single letters. Judged on proportion and nuqta.",
     "branchIds": ["br-marol"], "excerpts": [], "coverStorageKey": None, "startDate": "2026-11-05", "endDate": "2026-11-25", "status": "open", "resultsPublished": False,
     "entryCount": 6, "myEntry": {"id": "e9", "imageStorageKey": "entries/mine.jpg", "createdAt": "2026-11-08T10:00:00Z"}, "selections": []},
    {"id": "k3", "kind": "competition", "title": "Ramadan Kitabat", "description": "Results are out.", "branchIds": None, "excerpts": [], "coverStorageKey": None,
     "startDate": "2026-03-01", "endDate": "2026-03-25", "status": "completed", "resultsPublished": True, "entryCount": 40, "myEntry": None,
     "selections": [
         {"entryId": "e1", "studentId": "stu-2", "studentName": "Zahra Bootwala", "branchName": "Surat", "label": "Winner", "rank": 1, "imageStorageKey": "entries/e1.jpg", "publishedToGallery": True},
         {"entryId": "e2", "studentId": "stu-1", "studentName": "Fatema Hakimuddin", "branchName": "Marol", "label": "Runner-up", "rank": 2, "imageStorageKey": "entries/e2.jpg", "publishedToGallery": True},
         {"entryId": "e3", "studentId": "stu-3", "studentName": "Murtaza Saify", "branchName": "Nairobi", "label": "Honourable mention", "rank": 3, "imageStorageKey": "entries/e3.jpg", "publishedToGallery": False},
     ]},
]

ENTRIES = [
    {"id": f"e{i}", "studentId": f"stu-{i}", "studentName": n, "branchName": b, "imageStorageKey": f"entries/e{i}.jpg", "createdAt": "2026-11-0{}T10:00:00Z".format(i % 9 + 1),
     "selectionLabel": "Selected for decoration" if i == 2 else None, "selectionRank": None}
    for i, (n, b) in enumerate([("Zahra Bootwala", "Surat"), ("Fatema Hakimuddin", "Marol"), ("Murtaza Saify", "Nairobi"), ("Insiya Kapasi", "Karachi"),
                                 ("Huzefa Lokhandwala", "Sidhpur"), ("Sakina Rangwala", "Marol")], start=1)
]

HIGHLIGHTS = [
    {"id": "h1", "kind": "call", "competitionTitle": "Ashara decoration", "studentName": "Fatema Hakimuddin", "branchName": "Marol", "label": "Selected for decoration", "imageStorageKey": "entries/e2.jpg", "createdAt": "2026-11-09T10:00:00Z"},
    {"id": "h2", "kind": "competition", "competitionTitle": "Ramadan Kitabat", "studentName": "Zahra Bootwala", "branchName": "Surat", "label": "Winner", "imageStorageKey": "entries/e1.jpg", "createdAt": "2026-11-02T10:00:00Z"},
    {"id": "h3", "kind": "competition", "competitionTitle": "Ramadan Kitabat", "studentName": "Murtaza Saify", "branchName": "Nairobi", "label": "Honourable mention", "imageStorageKey": "entries/e3.jpg", "createdAt": "2026-11-01T10:00:00Z"},
]

SHOWCASE_REQUESTS = [
    {"id": "r1", "studentName": "Sakina Rangwala", "branchName": "Marol", "storageKey": "showcase/r1.jpg", "caption": "My first Thuluth alif–laam", "createdAt": "2026-11-08T10:00:00Z"},
    {"id": "r2", "studentName": "Insiya Kapasi", "branchName": "Karachi", "storageKey": "showcase/r2.jpg", "caption": None, "createdAt": "2026-11-09T10:00:00Z"},
]

THREAD = {
    "student": {"id": "stu-1", "name": "Fatema", "email": "x", "trNumber": None, "className": None, "branchName": "Marol"},
    "step": {"id": "s13", "code": "S03", "title": "Level 1 assessment", "stepType": "assessment", "levelCode": "LV01", "levelDescription": "مفردات", "courseCode": "FNK-C101", "courseTitle": "Naskh"},
    "messages": [], "annotations": [], "canReview": False,
    "submissions": [{"id": "sub1", "studentId": "stu-1", "stepId": "s13", "levelId": "l1", "courseId": "c1", "attemptNo": 1, "status": "passed", "mark": 9, "band": "distinction", "rubric": None,
                     "files": [{"storageKey": "subs/a.jpg", "originalFilename": "sheet1.jpg", "contentType": "image/jpeg"}, {"storageKey": "subs/b.jpg", "originalFilename": "assessment.jpg", "contentType": "image/jpeg"}],
                     "claimedById": None, "claimedByName": None, "reviewedById": None, "reviewedByName": None, "reviewedAt": None, "createdAt": "2026-10-10T10:00:00Z", "printCode": "TK-AAAAA", "autoMarked": False, "divertedCount": 0}],
}

BRANCHES = [{"id": "br-nairobi", "name": "Nairobi"}, {"id": "br-surat", "name": "Surat"}, {"id": "br-karachi", "name": "Karachi"}, {"id": "br-marol", "name": "Marol"}, {"id": "br-sidhpur", "name": "Sidhpur"}]

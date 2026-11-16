# Smart Attendance Interface (HCI Final Project #18)

A redesigned attendance system for **teachers and students**, built as a mobile-first web app.
Full stack: Node.js backend + SQLite database + vanilla JS frontend. No installs needed (Node 22+).

## Run it

```bash
cd smart-attendance
npm start            # http://localhost:3000
npm test             # API tests for attendance, schedules, edits and archives
```

### Use it at school without Internet

The laptop running this app is the local server and shared database. Internet is not needed while the laptop and phones can communicate over the same local Wi-Fi:

1. Turn on the teacher’s phone hotspot.
2. Connect the laptop and students’ phones to that hotspot.
3. On the laptop, run `npm start` and keep it awake with the terminal open.
4. Open the Wi-Fi/LAN address printed in the terminal on each phone and sign in.

The hotspot must allow connected devices to reach one another. If students cannot open the laptop’s address, check the phone’s hotspot client-isolation setting and allow Node.js on the laptop’s **private-network** firewall. A basic Wi-Fi access point/router is the fallback if the phone hotspot blocks device-to-device traffic. Keep the laptop on the same hotspot for the whole class; it is the source of the clock and the shared records.

Students can bookmark the address or add it to their home screen for convenience. This project includes a PWA manifest and app-shell cache, but **a normal HTTP hotspot address is not a secure context on phones**, so browsers generally will not permit PWA installation or offline app-shell caching from that address. A trusted HTTPS setup on the laptop (or a packaged native app) is needed for true install-once access over the hotspot. Merely installing this app from another HTTPS site will not connect it to the laptop: browser security blocks an HTTPS app from calling the laptop’s plain-HTTP API. Installation is per device and is not guaranteed to survive cleared browser data or device changes. Cached files do not enable attendance while the laptop server is unreachable.

| Role | Login | Password |
|---|---|---|
| Teacher (teaches HCI) | `teacher1` | `teacher123` |
| Teacher (teaches Rizal) | `teacher2` | `teacher123` |
| Student (Sec A) | `2024-001` … `2024-005` | same as ID |
| Student (Sec B) | `2024-006` … `2024-010` | same as ID |

Seed data includes 3 weeks of attendance history. HCI meets Mon–Fri 3:00–4:00 PM, Rizal 1:00–2:00 PM.

## Your design, as built

**Check-in rule** (from your notes; the window is per class): start → start+15 min = **Present**; +16 min → end = **Late**; otherwise **Absent** (check-in is blocked; no scan by class end = Absent).

**Teacher flow:** login → create or edit a class (subject, days, time) → register students by section → show the QR code and rotating code only during the assigned class time → live roster by section (P / L / A) → reports.
**Student flow:** login → check in (scan QR *or* type the current 8-character code; your Student ID comes from your login) → attendance status, class schedule, attendance history.

| Required feature | Where |
|---|---|
| Student login | Login screen (teachers use the same form) |
| Attendance status | Student Home → "Attendance status today" |
| Class schedule | Home (today) and Schedule tab (weekly) |
| Attendance history | History tab (filter by class, rates) |
| Instructor dashboard | Teacher → Classes (live counts) and class page (roster) |
| Reports | Teacher → Reports (per student, per date, CSV, print) |

## Testing without waiting for class: the Demo clock
Open **Demo clock** (bar under the header), pick e.g. *Mon 9 Nov 3:05 PM*, and try Present (3:00–3:15), Late (3:16–4:00), too early, and closed. "Use real time" resets it. It affects everyone on the server (for demos only).

## HCI focus: reducing errors in attendance recording
| Error risk | Design response | Principle |
|---|---|---|
| Typo or stale check-in code | Auto-uppercase, auto hyphen, ambiguous letters (O/0, I/1/L) never used, Continue disabled until 8 characters; QR/code changes every 30 seconds | Error prevention; Hick's/Fitts' |
| Checking in to the wrong class / as the wrong person | **Confirm screen** shows class, section, your name/ID and the status you'll get before saving; "Not my class" escape | Prevent errors; user control |
| Double check-in | Idempotent: shows "Already checked in at…" | Consistency; feedback |
| Wrong/late/early attempts | Specific message + what to do ("Starts at 3:00 PM", "Ask your teacher if this is a mistake") | Help users recover from errors |
| Teacher mis-marking | Tap a student → Present/Late/Absent; **Undo** toast; rows say "edited by you" | User control; visibility |
| Old QR screenshot reused later | QR/code is only issued during the scheduled check-in window and expires after 30 seconds; server rechecks the schedule, token and enrollment | Safety |
| Incorrect class/student details | Teachers can edit class and student details; schedule changes take effect the next day; classes can be archived/restored without deleting attendance | Error recovery |
| Teacher correction | Attendance corrections and class/student edits are recorded in the class change history, including teacher, time and correction reason when supplied | Accountability |
| Bad student lists | Bulk add reports line-by-line problems instead of failing silently | Error recovery |
| Remote spoofing of IDs | Login required; session cookie is HttpOnly; passwords hashed (scrypt); login rate-limited | Ethics: security/privacy |

Other principles applied: visibility of status (live roster, clock, status chips with icon + text, never colour alone), recognition over recall, minimalist UI (4 tabs for students, 3 for teachers), consistent buttons/chips, familiar icons with labels, WCAG-AA contrast, 44–60 px tap targets, keyboard + screen-reader support (landmarks, labels, live regions, skip link), **A+ larger-text toggle**, reduced-motion support, Data Privacy Act-minded data (account IDs, names, attendance and teacher change history).

## Built-in usability metrics (Lesson 3)
**Reports → Usability metrics** records real check-ins: success rate (task completion), median time to check in (time on task), student errors by type (error rate), and teacher corrections. Use these numbers in your evaluation write-up.

### Suggested test plan
1. 5+ representative users; tasks: *(student)* check in to HCI by QR, by typed code, find yesterday's status; *(teacher)* create a class, register 3 students, mark one Late, download the CSV.
2. Run moderated think-aloud sessions; note errors and confusion.
3. Read the metrics page; compute task completion = successes ÷ attempts.
4. Fix the top problems, retest (iterate), and report before/after.

## Attendance safeguards and limits
- The server only offers a rotating check-in token on the assigned class days and between its scheduled start and end. Tokens change every 30 seconds; an expired screenshot is rejected. Manual code entry uses that same short-lived token.
- Check-in also requires the student to be signed in and enrolled in the class. The live roster lets the teacher confirm who is physically present.
- A QR scan cannot prove that the student is in the room or stays for class. Someone can relay a currently valid code in real time. For that, the teacher must verify the live roster in the room; occasional verbal/in-person checks are stronger than GPS or a static QR. This prototype does not claim to automatically prove physical presence.
- QR scanning uses the browser's camera API, which needs **HTTPS or localhost**. On plain-http hotspot Wi-Fi, students can scan with the phone's normal camera app (it opens the check-in screen) or type the current code.
- The app shell can be cached only when delivered from a secure HTTPS origin. The cache does not queue check-ins; all attendance and login requests require the app server to be reachable. Disconnected-device check-ins are not accepted as confirmed attendance.
- Students' first password is their Student ID (prototype shortcut; a real system would force a change).
- Class archiving is reversible and preserves reports; it is not permanent data erasure. Schedule edits begin the next day to protect past attendance.
- Not included: password change, email notifications, or automated proof that a student remained in class.

## Files
`server.js` API + database + rules · `public/` app (`app.js`, `styles.css`, `qr.js` own QR generator) · `test.js` API tests · `data/` SQLite file (created on first run; delete to reset).

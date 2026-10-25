# tick_clone

**A self-hosted notes & tasks app that keeps everything as plain Markdown files.** Lists, tags, saved filters, calendar, due dates & repeats, push reminders, offline-first PWA — with a TickTick-like feel, running on your own computer. **One note = one `.md` file.** Your notes stay yours: open them in any editor, `grep` them, script them, `git` them.

> 日本語の README は [README.md](README.md)。The app UI and the in-app docs are in **Japanese** (the code and file format are language-neutral).

![Demo (fake data)](docs/images/demo.gif)

![Main screen](docs/images/screenshot-main.jpg)

> **Write first. Let the app sort it.** — mark a note as a note, set a deadline, or add a `#tag`, and tick_clone files it into the right list for you.

---

## ⚠ Read this first: no login by default

- By default there is **no authentication**: anyone who can open the page can read and rewrite **all** notes.
- It listens on `127.0.0.1` (your own computer only). To use it from your phone, use a private network such as **Tailscale** (`tailscale serve`, never `tailscale funnel`).
- **Do not expose it to the public internet** (port forwarding, public tunnels, …).
- Notes are stored on the server's disk **unencrypted**.

### Optional access token

Set the environment variable **`TICK_TOKEN`** and only people who know it can use the app (browsers sign in at `/login`; the Chrome extension has a token field in its options).

```bash
python -c "import secrets; print(secrets.token_urlsafe(24))"   # generate a long random token
# Windows PowerShell:  $env:TICK_TOKEN="<token>"; python -m uvicorn main:app --app-dir app --host 127.0.0.1 --port 8765
# Mac / Linux:         TICK_TOKEN="<token>" ./start.sh
```

- Unset = no authentication (the default).
- The cookie holds a derived value, not the token itself (HttpOnly, SameSite=Lax, Secure over HTTPS); repeated failures are rate-limited.
- **This is not a reason to put it on the public internet.** It is a single shared token and does not encrypt traffic — use it over HTTPS such as `tailscale serve`.

---

## What makes it different

- **Your notes are just files.** `data/notes/YYYY/MM/<id>.md`, with a small front-matter (`kind`, `list`, `due`, `status`, `completed`, …). The SQLite index (`index.db`) is disposable — delete it and it is rebuilt from the files. See [docs/ファイル形式.md](docs/ファイル形式.md) (Japanese) for every key.
- **Sorting is built in, not manual.** Notes ⊂ a "Reference" list, deadlines → a "Someday/Oneday" list, events → a "Next actions" list, and deadlines that get close move on their own (once a day, with an *Undo*). You configure it by right-clicking a list.
- **Completed ≠ cancelled.** Cancelling a task or event keeps the note and its date, but it never counts as an accomplishment. The *completed date* is an honest record of what you actually did.
- **Notes vs tasks, deadlines vs events.** Two simple rules: *"does *done* fit?"* and *"what happens after the date passes?"*
- **Local history.** Every change is recorded in the data folder's own git repository; trash is restorable.
- **Works offline, on your phone.** PWA with local IndexedDB and sync, Android back-button support, push notifications.

## Features

- Markdown editing in place (line by line), checklists, images/PDF attachments, automatic page titles for pasted URLs
- Lists (folder/list, 2 levels), hierarchical colored tags, **saved filters** (AND/OR, include/exclude), notes vs tasks
- Due dates & times, events vs deadlines, multi-day events, repeats, reminders (push), suggestions from dates in the text ("next Sunday noon")
- Calendar (small + large month view), completed-date view, cancel/skip a repeat
- Multi-select, bulk actions, drag & drop, **Undo** for bulk operations, command palette, keyboard shortcuts
- Chrome extension: right-click → add selection / page / link / image
- TickTick CSV import (`tools/import_ticktick.py`)

## Quick start (5 minutes)

Requirements: **Python 3.10+** and **git** (used for the change history).

```bash
git clone https://github.com/masarusama/tick_clone.git
cd tick_clone
python -m venv .venv
# Windows: .venv\Scripts\activate      Mac/Linux: source .venv/bin/activate
pip install -r requirements.txt
```

| OS | Start |
|---|---|
| Windows | `start.bat` |
| Mac / Linux | `./start.sh` |
| any | `python -m uvicorn main:app --app-dir app --host 127.0.0.1 --port 8765` |

Open **http://127.0.0.1:8765/**. Data goes to `data/` (override with `TICK_DATA`).

Try it with fake data first:

```bash
python tools/seed_demo.py                       # creates ./data-demo
TICK_DATA=data-demo python -m uvicorn main:app --app-dir app --host 127.0.0.1 --port 8765
# PowerShell: $env:TICK_DATA="data-demo"; python -m uvicorn main:app --app-dir app --host 127.0.0.1 --port 8765
```

## Phone / other devices

Install [Tailscale](https://tailscale.com/) on the PC and phone → on the PC run `tailscale serve --bg 8765` → open the `https://<pc>.<tailnet>.ts.net/` address on the phone → "Add to Home screen". Enable notifications from the 🔔 button (keys are created in `data/push/` — never share them).

## Backup, import, tests

```bash
python tools/backup.py --dest /path/to/backup                  # zip of notes + history, attachments copied incrementally
python tools/import_ticktick.py export.csv --data data          # TickTick CSV → notes (lists, kinds, due dates, repeats, …)
python tools/run_tests.py                                        # each test runs against a fresh empty data folder
```

## Limitations

- UI and docs are Japanese only.
- Timestamps are recorded in **Japan time (JST, +09:00)**; other time zones are not supported yet.
- Single user. No sharing or permissions.
- External edits to the `.md` files are picked up when the server restarts.
- No warranty — keep backups. Not affiliated with TickTick; the name only reflects the inspiration.

## License

[MIT](LICENSE)

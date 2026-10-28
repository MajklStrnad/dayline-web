# Dayline (web / PWA)

A web copy of the Android app. No build step, no dependencies: plain HTML, CSS and JS.

## Run it
Any static host works, but it **must be served over HTTPS** (or `localhost`) for install and notifications:

    cd dayline-web && python3 -m http.server 8080     # then open http://localhost:8080

Deploy by uploading this folder to Netlify, Cloudflare Pages, GitHub Pages, Vercel, etc.
It works from a sub-folder too (all paths are relative).

## Install
- Android / Chrome / Edge: browser menu -> Install app (or the install icon in the address bar)
- iPhone / iPad: Safari -> Share -> Add to Home Screen
- Desktop Chrome / Edge: install icon in the address bar

## Desktop layout (window 900px or wider)
Calendar sidebar + day pane, a toolbar (previous/next day, Today, New task), centred dialogs instead of
bottom sheets, All tasks as a side drawer, hover states, and a delete button on hovered rows.
Shortcuts: Left/Right = previous/next day, T = today, N = new task, Esc = close, Enter = save.
In the time dialog you can type the time instead of using the dial.
Phones and narrow windows keep the touch layout.

## Updating
Change any file, then bump `VERSION` in `sw.js` (e.g. `dayline-v3`) so installed copies refresh.

## Data
Tasks, language and theme live in the browser's localStorage on each device (not synced, and
not shared with the Android app).

## Reminders: the one real difference from Android
Browsers cannot schedule exact alarms while an app is closed. Dayline checks reminders every
second while it is open and shows a system notification; tasks that came due before it was opened
are not re-fired. Works on desktop and Android Chrome (best effort in the background). On iPhone
it needs the app on the Home Screen (iOS 16.4+) and in practice only fires while the app is open on
screen. Reliable closed-app reminders would need a push server.

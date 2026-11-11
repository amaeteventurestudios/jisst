# Jisste website

The public site for Jisste (free) and Jisste Teams (paid), in Onyx & Gold. Static: `index.html`, `site.css`, `site.js` and
`img/`. No build step and no outside code.

- Light and dark follow the device; the sun/moon button overrides it (saved in the browser).
- "How it works" is a window that stays put while the six steps scroll past; the step nearest the middle of the screen
  (lower on phones) picks which screen the window shows. The screens are HTML, not pictures, so they stay sharp and
  follow the theme.
- Reduced motion: nothing moves, everything is shown.
- The screenshots in `img/` come from the app's demo (`/?demo`) and the Jisste Teams demo team. Retake them when the
  apps change.

Look at it: `python3 -m http.server 8866` in this folder, then open http://localhost:8866.
Check 390x844 and 1280x800, light and dark.

Where it runs: the same server as the app. `server/install.sh` serves `site/` on `JISST_SITE_DOMAIN` (default
jisste.noveniqe.com) and sends anything that isn't a website file to the app (app.jisste.noveniqe.com), so old app links
keep working. `site/sw.js` removes the old app's service worker from browsers that had the app on this address.
"Open Jisste" opens a chooser (Jisste for you, Jisste Teams for your business). `TEAMS_LIVE` in `site.js` is on since
teams.jisste.noveniqe.com went live (10 Nov 2026); set it to false to show "opening soon" again.

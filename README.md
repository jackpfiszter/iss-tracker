# ISS Tracker

A live 3D tracker for the International Space Station. A photoreal Earth shows where the ISS is right now, the orbit it just flew and the one it's about to fly. The clouds are real (from the last few hours), the aurora follows NOAA's forecast, and the stars and moon are where they really are. Ride along behind the station, or share your location to see when it will next pass over you bright enough to see.

## Run it

It's plain static files with no build step. Serve the folder with any local web server:

```sh
npx serve -l 8765
# or
python3 -m http.server 8765
```

Then open http://localhost:8765. Opening `index.html` straight from disk won't work, because the textures and data are loaded with `fetch`.

## Camera modes

| Key | Mode | What you see |
| --- | --- | --- |
| `1` | **Earth** | The whole planet, with a label on the ISS. Left alone, the view eases round to keep the ISS in frame. |
| `2` / `F` | **Ride along** | A chase camera behind a 3D ISS whose solar arrays track the sun. Drag to look around, scroll to pull back. |
| `3` / `C` | **Cupola** | Inside the station's seven-window Cupola, a 3D dome lit by the real sun (light falls through the windows onto the frames). Drag to look around, scroll to zoom the lens. |
| `4` | **My sky** | Flies to your location and draws the next visible pass on the ground and on a sky chart. |

`R` or `Esc` returns to the Earth view. Drag (or one finger) rotates, scroll (or pinch) zooms.

## Extras

- **Time machine** (`T`, or click the clock): pause, play at up to 3,600× (an hour a second), or scrub from a day ago to three days ahead. The ISS, sun, moon, stars, day and night and the pass predictions all follow; a chip by the clock shows you're off live time. Live weather and the live camera stay in the present.
- **Other spacecraft:** China's Tiangong station and the Hubble Space Telescope, with their orbits, in the Earth and My sky views.
- **Clouds** (`K`, or the cloud button): hide the cloud layer for a clear view of the surface. Remembered in this browser.
- **Sound** (`M`, or the speaker button): an optional ambient soundscape made in the browser, warmer in sunlight and darker in Earth's shadow, with a chime at each orbital sunrise and sunset.

## The card

- **Now:** speed, place below ("Over Japan"), heading, an orbit dial showing sunlit and shadow stretches with a countdown to the next orbital sunrise or sunset.
- **Passes:** **Use my location** asks the browser for your position and lists the next visible passes this week. A pass only counts when the ISS is more than 10° up, still sunlit, and your sky is dark (sun more than 6° below the horizon). Your location is stored in this browser only, rounded to about 1 km.
- **Crew:** who's aboard right now, with photos, agency and how many days they've been up, plus everyone else in space today and how far away Tiangong is.
- **Live:** NASA's live video from the ISS (an Earth-facing camera, or the main station feed). It only loads while the tab is open, and the note under it says when the station is in Earth's shadow and the picture will be dark.
- **News:** recent spaceflight headlines.

On phones the card is a bottom sheet: tap or swipe it up for the tabs, and the globe re-centres in the space left above it.

## How it works

The app downloads the ISS's current orbital elements (a TLE) and uses [satellite.js](https://github.com/shashwatak/satellite-js) to compute its position for any moment. That makes the marker move smoothly, draws the past and future orbit, and powers the pass predictions without polling an API. The TLE is refreshed every 2 hours; the status pill turns amber or red if it can't be refreshed or gets stale.

- `astro.js`: orbit, sun and moon maths (pure functions, no DOM)
- `places.js`: place names from country outlines
- `globe.js`: the Three.js scene (Earth, clouds, aurora, atmosphere, ISS, orbit lines) and the render pipeline
- `sky.js`: stars, Milky Way, sun and moon
- `station.js`: the ISS model, its lights and its shadows
- `detail.js`: streams sharp NASA tiles in around the camera when it's close
- `weather.js`: live cloud map and aurora forecast
- `timemachine.js`: the shared clock (`clockNow()`) and the time machine
- `spacecraft.js`: Tiangong and Hubble
- `crew.js`, `livecam.js`, `sound.js`: the Crew and Live tabs and the ambient sound
- `app.js`: data, camera modes and UI

### The look

- **Light:** lighting is worked out in linear light, then bloom, exposure and filmic (ACES) tone mapping run as a last pass, so the sun, glint, city lights and aurora can glow without washing out the rest. Without WebGL2 or the bloom scripts it draws the same scene without bloom.
- **Atmosphere:** each pixel works out how much air the view passes through (Rayleigh and Mie scattering), giving the blue limb, orange light along the terminator and haze towards the horizon. The night-side limb has the faint green airglow line astronauts photograph.
- **Art direction:** lightly tuned for looks while staying close to real photos. Haze over the ground is thinned and the limb slightly boosted, a faint halo surrounds the planet from far away, oceans are a touch deeper, the night side keeps its continents faintly moonlit with warm city lights, and a light grade restores some of the colour filmic tone mapping takes out.
- **The station:** NASA's 3D model of the ISS, with solar arrays that turn to face the sun, blue earthshine from below, its own shadows up close, and sunlight that reddens and fades as it passes through the atmosphere at each orbital sunrise and sunset.
- **Clouds and sea:** cloud tops are shaded by their own relief and cast shadows away from the sun; up close their edges break into cumulus puffs. The sun's glint sparkles on the sea, and up close (Ride along, Cupola) the odd lightning strike lights up storm clouds on the night side (not with reduced motion).
- **Camera:** a slow handheld drift in Ride along, a lens finish (vignette, faint grain, slight colour fringing), and a lens flare when you look towards the sun: a starburst, a faint rainbow ring and soft ghosts, rendered into the image before tone mapping. Up close over the sunlit Earth the stars fade, as they would for a camera.
- **Close-ups:** the base Earth images are about 10 km a pixel. In Ride along, My sky or when zoomed in, `detail.js` fetches NASA tiles at up to ~500 m a pixel for the area in view (city lights on the night side), and only for the side of the terminator that needs them.
- **Quality:** phones start at a lighter setting, and if the first seconds run slow it steps down automatically. Add `?q=low`, `?q=medium` or `?q=high` to pin it.

Add `?t=<minutes>` to the URL to shift the clock, e.g. `?t=30` to see the ISS in Earth's shadow.

## Data sources

- Orbital elements: [Where the ISS at?](https://wheretheiss.at/), falling back to [CelesTrak](https://celestrak.org/)
- Earth imagery: NASA Blue Marble and Black Marble (public domain), in `textures/`
- Close-up imagery: [NASA GIBS](https://nasa-gibs.github.io/gibs-api-docs/) (Blue Marble shaded relief and bathymetry; VIIRS city lights 2012)
- Live clouds: [live-cloud-maps](https://github.com/matteason/live-cloud-maps), updated every 3 hours. Contains modified EUMETSAT data. Falls back to a stock cloud texture.
- Aurora: [NOAA SWPC](https://www.swpc.noaa.gov/products/aurora-30-minute-forecast) 30-minute forecast
- Stars: the [Yale Bright Star Catalogue](https://cdsarc.cds.unistra.fr/viz-bin/cat/V/50), 5th edition, trimmed to position, magnitude and colour in `data/stars.json`
- ISS model: [NASA 3D Resources](https://github.com/nasa/NASA-3D-Resources) (International Space Station B), in `models/`
- Relief, ocean mask, stock clouds and the moon: the [three.js](https://github.com/mrdoob/three.js) example textures, loaded from jsDelivr (the globe still renders without them)
- Country outlines: [Natural Earth](https://www.naturalearthdata.com/) 1:110m, trimmed to names and outlines in `data/`
- News: [Spaceflight News API](https://spaceflightnewsapi.net/) (updates every 10 min)
- Crew: [international-space-station-APIs](https://github.com/corquaid/international-space-station-APIs) (community maintained), photos from Wikimedia Commons
- Live video: NASA's official YouTube streams, embedded from youtube-nocookie.com. NASA occasionally restarts these streams under a new address; `LIVE_CAMS` in `livecam.js` holds the current ones, and the ↗ button opens NASA's live page.
- Tiangong and Hubble orbits: [CelesTrak](https://celestrak.org/), falling back to [TLE API](https://tle.ivanstanojevic.me/)

None of these need an API key.

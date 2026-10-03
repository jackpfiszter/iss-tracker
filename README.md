# ISS Tracker

A live 3D tracker for the International Space Station. A wireframe globe built with Three.js shows where the ISS is right now, the trail it has flown, and the point on the ground beneath it. Glass-style panels show live telemetry and recent spaceflight news.

## Run it

It's plain static files with no build step. Serve the folder with any local web server:

```sh
python3 -m http.server 8765
```

Then open http://localhost:8765.

## Controls

- **Drag** to rotate the globe (up/down tilt is capped at the poles)
- **Scroll** to zoom

## Data sources

- ISS position: [Where the ISS at?](https://wheretheiss.at/) (updates every 2 s)
- Coastlines: [Natural Earth](https://github.com/nvkelso/natural-earth-vector) 1:110m land
- News: [Spaceflight News API](https://spaceflightnewsapi.net/) (updates every 10 min)

None of these need an API key.

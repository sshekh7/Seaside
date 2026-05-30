"use client";

import { useEffect, useRef, useState, useCallback } from "react";
import dynamic from "next/dynamic";
import mapboxgl from "mapbox-gl";
import "mapbox-gl/dist/mapbox-gl.css";
import { genConfig } from "react-nice-avatar";
import type { AvatarFullConfig, NiceAvatarProps } from "react-nice-avatar";

const Avatar = dynamic(() => import("react-nice-avatar"), {
  ssr: false,
  loading: () => <div className="size-full animate-pulse rounded-full bg-muted/40" />,
}) as React.ComponentType<NiceAvatarProps>;

const TOKEN = process.env.NEXT_PUBLIC_MAPBOX_TOKEN!;

const STYLES = {
  Dark: "mapbox://styles/mapbox/dark-v11",
  Light: "mapbox://styles/mapbox/light-v11",
  Streets: "mapbox://styles/mapbox/streets-v12",
  Satellite: "mapbox://styles/mapbox/satellite-streets-v12",
};

const START: [number, number] = [-122.3425, 47.6097];
const END: [number, number] = [-122.3399, 47.6062];

const AGENT = {
  name: "Atlas",
  personality: "A curious urban explorer who loves discovering hidden gems in the city. Methodical and observant, always taking the scenic route.",
  config: genConfig(),
};

async function fetchRoute(start: [number, number], end: [number, number]): Promise<[number, number][]> {
  const res = await fetch(
    `https://api.mapbox.com/directions/v5/mapbox/walking/${start[0]},${start[1]};${end[0]},${end[1]}?geometries=geojson&steps=true&access_token=${TOKEN}`
  );
  const data = await res.json();
  return data.routes[0].geometry.coordinates;
}

// Interpolate between route points for smoother movement
function interpolateRoute(coords: [number, number][], stepsPerSegment: number): [number, number][] {
  const result: [number, number][] = [];
  for (let i = 0; i < coords.length - 1; i++) {
    const [x1, y1] = coords[i];
    const [x2, y2] = coords[i + 1];
    for (let j = 0; j < stepsPerSegment; j++) {
      const t = j / stepsPerSegment;
      result.push([x1 + (x2 - x1) * t, y1 + (y2 - y1) * t]);
    }
  }
  result.push(coords[coords.length - 1]);
  return result;
}

export default function MapPage() {
  const mapContainer = useRef<HTMLDivElement>(null);
  const mapRef = useRef<mapboxgl.Map | null>(null);
  const popupRef = useRef<mapboxgl.Popup | null>(null);
  const timerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const speedRef = useRef(200); // ms per interpolated step (slow default)
  const [style, setStyle] = useState<keyof typeof STYLES>("Dark");
  const [zoom, setZoom] = useState(16);
  const [pitch, setPitch] = useState(0);
  const [bearing, setBearing] = useState(0);
  const [is3D, setIs3D] = useState(false);
  const [agentRunning, setAgentRunning] = useState(false);
  const [speed, setSpeed] = useState(1); // 1x default
  const [showProfile, setShowProfile] = useState(false);
  const [profilePos, setProfilePos] = useState<{ x: number; y: number }>({ x: 0, y: 0 });

  useEffect(() => {
    speedRef.current = 200 / speed;
  }, [speed]);

  useEffect(() => {
    const map = new mapboxgl.Map({
      container: mapContainer.current!,
      accessToken: TOKEN,
      style: STYLES[style],
      center: START,
      zoom,
      pitch,
      bearing,
      dragRotate: true,
      touchPitch: true,
      touchZoomRotate: true,
    });
    map.addControl(new mapboxgl.NavigationControl({ visualizePitch: true }), "top-right");
    mapRef.current = map;

    map.on("moveend", () => {
      setZoom(Math.round(map.getZoom() * 10) / 10);
      setPitch(Math.round(map.getPitch()));
      setBearing(Math.round(map.getBearing()));
    });

    // Click on agent dot to show profile
    map.on("click", "agent-dot", (e) => {
      const point = e.point;
      setProfilePos({ x: point.x, y: point.y });
      setShowProfile(true);
    });

    map.on("mouseenter", "agent-dot", () => {
      map.getCanvas().style.cursor = "pointer";
    });
    map.on("mouseleave", "agent-dot", () => {
      map.getCanvas().style.cursor = "";
    });

    return () => {
      if (timerRef.current) clearTimeout(timerRef.current);
      map.remove();
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [style]);

  const startAgent = useCallback(async () => {
    const map = mapRef.current;
    if (!map) return;

    setAgentRunning(true);
    setShowProfile(false);
    const route = await fetchRoute(START, END);
    const smoothRoute = interpolateRoute(route, 5);

    // Route line
    if (map.getSource("route")) {
      (map.getSource("route") as mapboxgl.GeoJSONSource).setData({
        type: "Feature", properties: {},
        geometry: { type: "LineString", coordinates: route },
      });
    } else {
      map.addSource("route", {
        type: "geojson",
        data: { type: "Feature", properties: {}, geometry: { type: "LineString", coordinates: route } },
      });
      map.addLayer({
        id: "route-line", type: "line", source: "route",
        paint: { "line-color": "#4882c5", "line-width": 3, "line-opacity": 0.6, "line-dasharray": [2, 1] },
      });
    }

    // Agent point
    const agentData: GeoJSON.Feature<GeoJSON.Point> = {
      type: "Feature", properties: {},
      geometry: { type: "Point", coordinates: smoothRoute[0] },
    };
    if (map.getSource("agent")) {
      (map.getSource("agent") as mapboxgl.GeoJSONSource).setData(agentData);
    } else {
      map.addSource("agent", { type: "geojson", data: agentData });
      map.addLayer({
        id: "agent-glow", type: "circle", source: "agent",
        paint: { "circle-radius": 14, "circle-color": "#ff4444", "circle-opacity": 0.2, "circle-blur": 1 },
      });
      map.addLayer({
        id: "agent-dot", type: "circle", source: "agent",
        paint: { "circle-radius": 7, "circle-color": "#ff4444", "circle-stroke-width": 2.5, "circle-stroke-color": "#fff" },
      });
    }

    // Animate
    let i = 0;
    const step = () => {
      if (i >= smoothRoute.length) {
        setAgentRunning(false);
        return;
      }
      (map.getSource("agent") as mapboxgl.GeoJSONSource).setData({
        type: "Feature", properties: {},
        geometry: { type: "Point", coordinates: smoothRoute[i] },
      });
      i++;
      timerRef.current = setTimeout(step, speedRef.current);
    };
    step();
  }, []);

  const toggle3D = () => {
    const map = mapRef.current;
    if (!map) return;
    if (is3D) {
      map.easeTo({ pitch: 0, bearing: 0 });
      if (map.getLayer("3d-buildings")) map.removeLayer("3d-buildings");
    } else {
      map.easeTo({ pitch: 60, bearing: -17 });
      map.once("idle", () => {
        if (!map.getLayer("3d-buildings")) {
          if (!map.getSource("composite")) {
            map.addSource("composite", { type: "vector", url: "mapbox://mapbox.mapbox-streets-v8" });
          }
          map.addLayer({
            id: "3d-buildings", source: "composite", "source-layer": "building",
            type: "fill-extrusion", minzoom: 14,
            paint: {
              "fill-extrusion-color": "#aaa",
              "fill-extrusion-height": ["get", "height"],
              "fill-extrusion-base": ["get", "min_height"],
              "fill-extrusion-opacity": 0.6,
            },
          });
        }
      });
    }
    setIs3D(!is3D);
  };

  const resetView = () => {
    mapRef.current?.flyTo({ center: START, zoom: 16, pitch: 0, bearing: 0 });
    setIs3D(false);
  };

  return (
    <div className="relative flex h-full flex-col">
      {/* Controls */}
      <div className="flex flex-wrap items-center gap-3 border-b border-border bg-card px-4 py-2">
        <span className="text-sm font-medium text-foreground">Style:</span>
        {Object.keys(STYLES).map((s) => (
          <button
            key={s}
            onClick={() => setStyle(s as keyof typeof STYLES)}
            className={`rounded px-2 py-1 text-xs transition ${
              style === s ? "bg-primary text-primary-foreground" : "bg-secondary text-secondary-foreground hover:bg-accent"
            }`}
          >
            {s}
          </button>
        ))}
        <div className="mx-1 h-4 w-px bg-border" />
        <button
          onClick={toggle3D}
          className={`rounded px-2 py-1 text-xs transition ${
            is3D ? "bg-primary text-primary-foreground" : "bg-secondary text-secondary-foreground hover:bg-accent"
          }`}
        >
          3D
        </button>
        <button onClick={() => mapRef.current?.easeTo({ bearing: mapRef.current.getBearing() - 15 })} className="rounded bg-secondary px-2 py-1 text-xs text-secondary-foreground hover:bg-accent">↺</button>
        <button onClick={() => mapRef.current?.easeTo({ bearing: mapRef.current.getBearing() + 15 })} className="rounded bg-secondary px-2 py-1 text-xs text-secondary-foreground hover:bg-accent">↻</button>
        <div className="mx-1 h-4 w-px bg-border" />
        <button
          onClick={startAgent}
          disabled={agentRunning}
          className={`rounded px-3 py-1 text-xs font-medium transition ${
            agentRunning ? "cursor-not-allowed bg-muted text-muted-foreground" : "bg-green-600 text-white hover:bg-green-700"
          }`}
        >
          {agentRunning ? "Walking…" : "Start Agent"}
        </button>
        <div className="mx-1 h-4 w-px bg-border" />
        <span className="text-xs text-muted-foreground">Speed:</span>
        <input
          type="range"
          min={0.25}
          max={5}
          step={0.25}
          value={speed}
          onChange={(e) => setSpeed(parseFloat(e.target.value))}
          className="h-1 w-20 cursor-pointer accent-primary"
        />
        <span className="text-xs font-mono text-muted-foreground">{speed}x</span>
        <div className="mx-1 h-4 w-px bg-border" />
        <span className="text-xs text-muted-foreground">
          Zoom: {zoom} · Pitch: {pitch}° · Bearing: {bearing}°
        </span>
        <button onClick={resetView} className="ml-auto rounded bg-secondary px-2 py-1 text-xs text-secondary-foreground hover:bg-accent">
          Reset
        </button>
      </div>

      {/* Map */}
      <div className="relative min-h-0 flex-1">
        <div ref={mapContainer} className="h-full w-full" />

        {/* Agent Profile Popup */}
        {showProfile && (
          <div
            className="absolute z-50 w-72 animate-in fade-in zoom-in-95 duration-200"
            style={{ left: profilePos.x - 136, top: profilePos.y - 260 }}
          >
            <div className="rounded-xl border border-border bg-card/95 p-4 shadow-2xl backdrop-blur-sm">
              <button
                onClick={() => setShowProfile(false)}
                className="absolute right-3 top-3 text-xs text-muted-foreground hover:text-foreground"
              >
                ✕
              </button>
              <div className="flex items-center gap-3">
                <div className="size-14 overflow-hidden rounded-full border-2 border-primary/30">
                  <Avatar style={{ width: "100%", height: "100%" }} {...AGENT.config} />
                </div>
                <div>
                  <h3 className="text-sm font-semibold text-foreground">{AGENT.name}</h3>
                  <span className="flex items-center gap-1 text-xs text-green-400">
                    <span className="inline-block size-1.5 rounded-full bg-green-400" />
                    Active
                  </span>
                </div>
              </div>
              <div className="mt-3 border-t border-border/60 pt-3">
                <p className="text-xs leading-relaxed text-muted-foreground">
                  {AGENT.personality}
                </p>
              </div>
              <div className="mt-3 flex gap-2 text-[10px] text-muted-foreground">
                <span className="rounded bg-secondary px-1.5 py-0.5">Walking</span>
                <span className="rounded bg-secondary px-1.5 py-0.5">Pike Place → Waterfront</span>
              </div>
            </div>
            <div className="mx-auto h-3 w-3 -translate-y-px rotate-45 border-b border-r border-border bg-card/95" />
          </div>
        )}
      </div>
    </div>
  );
}

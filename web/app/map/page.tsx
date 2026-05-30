"use client";

import { useEffect, useRef, useState } from "react";
import mapboxgl from "mapbox-gl";
import "mapbox-gl/dist/mapbox-gl.css";

const TOKEN =
  "pk.eyJ1Ijoic3NoZWtoNyIsImEiOiJjbXBycm1maWQxMmRtMnJxN3ExNGJ0M2N0In0.8a_FtEd1CxeQic9R_-priQ";

const STYLES = {
  Dark: "mapbox://styles/mapbox/dark-v11",
  Light: "mapbox://styles/mapbox/light-v11",
  Streets: "mapbox://styles/mapbox/streets-v12",
  Satellite: "mapbox://styles/mapbox/satellite-streets-v12",
};

export default function MapPage() {
  const mapContainer = useRef<HTMLDivElement>(null);
  const mapRef = useRef<mapboxgl.Map | null>(null);
  const [style, setStyle] = useState<keyof typeof STYLES>("Dark");
  const [zoom, setZoom] = useState(11);
  const [pitch, setPitch] = useState(0);
  const [bearing, setBearing] = useState(0);
  const [is3D, setIs3D] = useState(false);

  useEffect(() => {
    const map = new mapboxgl.Map({
      container: mapContainer.current!,
      accessToken: TOKEN,
      style: STYLES[style],
      center: [-122.3321, 47.6062],
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

    return () => map.remove();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [style]);

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
            id: "3d-buildings",
            source: "composite",
            "source-layer": "building",
            type: "fill-extrusion",
            minzoom: 14,
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
    mapRef.current?.flyTo({ center: [-122.3321, 47.6062], zoom: 11, pitch: 0, bearing: 0 });
    setIs3D(false);
  };

  return (
    <div className="flex h-full flex-col">
      <div className="flex items-center gap-4 border-b border-border bg-card px-4 py-2">
        <span className="text-sm font-medium text-foreground">Map Style:</span>
        {Object.keys(STYLES).map((s) => (
          <button
            key={s}
            onClick={() => setStyle(s as keyof typeof STYLES)}
            className={`rounded px-2 py-1 text-xs transition ${
              style === s
                ? "bg-primary text-primary-foreground"
                : "bg-secondary text-secondary-foreground hover:bg-accent"
            }`}
          >
            {s}
          </button>
        ))}
        <div className="mx-2 h-4 w-px bg-border" />
        <button
          onClick={toggle3D}
          className={`rounded px-2 py-1 text-xs transition ${
            is3D
              ? "bg-primary text-primary-foreground"
              : "bg-secondary text-secondary-foreground hover:bg-accent"
          }`}
        >
          3D
        </button>
        <button
          onClick={() => mapRef.current?.easeTo({ bearing: mapRef.current.getBearing() - 15 })}
          className="rounded bg-secondary px-2 py-1 text-xs text-secondary-foreground hover:bg-accent"
        >
          ↺
        </button>
        <button
          onClick={() => mapRef.current?.easeTo({ bearing: mapRef.current.getBearing() + 15 })}
          className="rounded bg-secondary px-2 py-1 text-xs text-secondary-foreground hover:bg-accent"
        >
          ↻
        </button>
        <div className="mx-2 h-4 w-px bg-border" />
        <span className="text-xs text-muted-foreground">
          Zoom: {zoom} · Pitch: {pitch}° · Bearing: {bearing}°
        </span>
        <button
          onClick={resetView}
          className="ml-auto rounded bg-secondary px-2 py-1 text-xs text-secondary-foreground hover:bg-accent"
        >
          Reset View
        </button>
      </div>
      <div className="min-h-0 flex-1">
        <div ref={mapContainer} className="h-full w-full" />
      </div>
    </div>
  );
}

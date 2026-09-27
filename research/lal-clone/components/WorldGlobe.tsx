"use client";

/**
 * WorldGlobe — the same 100 places the filmstrip shows, on a Cesium globe.
 *
 * Replaces react-globe.gl, which put one equirectangular photograph onto a
 * sphere. Fine at a glance, bad the moment you zoom: a single 1024px image
 * stretched over a planet cannot get sharp, and that is why it looked soft
 * next to Google Earth. Cesium streams imagery as tiles, so detail arrives as
 * you approach, and it also brings terrain, atmosphere and a real camera.
 *
 * ── The token, and why the page works without one ────────────────────────────
 * Cesium's default imagery comes from Cesium ion, which needs an account
 * token. Requiring one would leave the page blank on a fresh clone, so nothing
 * is hard-required:
 *
 *   - imagery -> OpenStreetMap raster tiles (no key, no account)
 *   - terrain -> EllipsoidTerrainProvider, a smooth sphere, no key
 *
 * Set NEXT_PUBLIC_CESIUM_ION_TOKEN and imagery switches to ion's global
 * satellite layer automatically. Terrain stays flat on purpose: ion's terrain
 * is metered per request, which is not something to switch on by accident in a
 * page anyone can load.
 *
 * ── Attribution is not optional ─────────────────────────────────────────────
 * Both OSM's tile policy and ion's terms require visible credit, so Cesium's
 * credit container is kept and styled rather than suppressed.
 */
import { useEffect, useMemo, useRef, useState } from "react";

/* Types only. `import type` is erased at compile time, so nothing of Cesium
   enters the webpack bundle -- see loadCesium below for the runtime story. */
import type * as CesiumNS from "cesium";

import type { Place } from "../data/places";
import { PLACES } from "../data/places";
import imageMeta from "../data/place-images.json";

type CesiumApi = typeof CesiumNS;

/**
 * Load the esbuild-bundled Cesium at runtime instead of importing "cesium".
 *
 * Importing "cesium" through webpack works in dev and yields a chunk no
 * browser will parse in production: the minifier rewrites one string into a
 * template literal and drops an escaped backslash, turning "\\5" into \5,
 * which is an illegal octal escape. The bytes live in the WebAssembly Cesium
 * embeds for its Draco decoders. The shipped build parses fine on its own, so
 * the minifier is at fault.
 *
 * So tools/copy-cesium-assets.mjs bundles Cesium with esbuild into
 * public/cesium/cesium.mjs and webpack never sees it. The URL goes through a
 * variable plus webpackIgnore so the import is left for the browser to
 * resolve at runtime rather than being resolved at build time.
 *
 * ~1.3MB gzipped, fetched once and cached. The promise is memoised at module
 * scope so a remount does not refetch, and a failed load clears the memo so a
 * later mount can retry rather than replaying the same rejection.
 */
const CESIUM_URL = "/cesium/cesium.mjs";

let cesiumPromise: Promise<CesiumApi> | null = null;

function loadCesium(): Promise<CesiumApi> {
  if (cesiumPromise) return cesiumPromise;
  // Must be set before the library initialises: it fetches Workers, Assets and
  // shaders relative to this path at runtime.
  (window as unknown as { CESIUM_BASE_URL: string }).CESIUM_BASE_URL = "/cesium/";
  cesiumPromise = import(/* webpackIgnore: true */ CESIUM_URL).catch((err: unknown) => {
    cesiumPromise = null;
    throw err;
  });
  return cesiumPromise;
}

const TOKEN = process.env.NEXT_PUBLIC_CESIUM_ION_TOKEN;
/**
 * Cesium ion asset for the satellite layer. 2 is ion's public "Natural Earth
 * II" basemap, which is a safe default on any account. For real satellite
 * imagery, copy the asset id from your own ion console into
 * NEXT_PUBLIC_CESIUM_ION_ASSET -- the default is a fallback, not a choice.
 */
const ION_ASSET = Number(process.env.NEXT_PUBLIC_CESIUM_ION_ASSET ?? 2);

/** Degrees per second for the idle spin. ~2 deg/s is a turn every three minutes. */
const SPIN_DEG_PER_SEC = 2;
/** How long after the last input before the globe resumes turning. */
const IDLE_MS = 2600;
/** Camera height over the selected place, metres. Regional, not street-level:
 *  enough to recognise the country, still far enough that the planet curves. */
const FOCUS_HEIGHT = 2_800_000;
/**
 * Camera height for the opening shot, metres.
 *
 * Cesium's default vertical FOV is 60 degrees, so the whole sphere only fills
 * the frame from about 8,400 km up: at 21,000 km the globe's angular radius is
 * 13.5 degrees and it occupies barely half the box, which reads as a small
 * marble in a lot of black. This is roughly where the limb sits near the edge
 * of the frame, which is the shot that actually looks like a planet.
 */
const ESTABLISH_HEIGHT = 8_600_000;

type Meta = { image: string; author: string; licence: string; commonsPage: string };
const META = imageMeta as unknown as Record<string, Meta>;

const slugOf = (s: string) =>
  s
    .normalize("NFD")
    .replace(/[̀-ͯ]/g, "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-|-$/g, "");

export type Pin = {
  id: string;
  name: string;
  country: string;
  code: string;
  region: string;
  lat: number;
  lng: number;
  index: number;
  meta?: Meta;
};

/**
 * Only places with coordinates can be plotted.
 *
 * Exported so the globe and the list beside it come from one pass. Derived
 * separately they would drift the moment a place lost coordinates, and clicking
 * a row would fly the camera to the wrong pin.
 */
export function buildPins(): Pin[] {
  const out: Pin[] = [];
  PLACES.forEach((place: Place, index: number) => {
    if (place.lat == null || place.lng == null) return;
    const id = slugOf(place.name);
    out.push({
      id,
      name: place.name,
      country: place.country,
      code: place.code,
      region: place.region,
      lat: place.lat,
      lng: place.lng,
      // Index into PLACES, not into `out`, so a card and its pin always agree
      // even if some places are dropped for want of coordinates.
      index,
      meta: META[id],
    });
  });
  return out;
}

/**
 * Entity graphics are typed as the abstract Property, but every one created
 * here is a ConstantProperty, which is what actually carries setValue. One
 * helper rather than a cast at each of the six call sites.
 */
function setProp<T>(prop: CesiumNS.Property | undefined, value: T) {
  (prop as CesiumNS.ConstantProperty | undefined)?.setValue(value);
}

export function WorldGlobe({
  active,
  onSelect,
  focusOnMount = false,
}: {
  active: number | null;
  onSelect: (index: number) => void;
  /**
   * True when the opening selection came from the URL rather than being the
   * default first card. Only then should the camera move immediately: a
   * default opening card is not a choice anyone made, but /globe?place=... is
   * an explicit instruction and silently showing the whole planet instead
   * ignores it.
   */
  focusOnMount?: boolean;
}) {
  const boxRef = useRef<HTMLDivElement>(null);
  const [ready, setReady] = useState(false);
  const [cesium, setCesium] = useState<CesiumApi | null>(null);

  const pins = useMemo(buildPins, []);

  const viewerRef = useRef<CesiumNS.Viewer | null>(null);
  /** entity id -> place index, for click and hover picking. Entity.id is a
      string in Cesium 1.145, not a number as it was in older releases. */
  const byEntityId = useRef(new Map<string, number>());
  /** place index -> entity, for repainting the selection. */
  const byIndex = useRef(new Map<number, CesiumNS.Entity>());

  const onSelectRef = useRef(onSelect);
  onSelectRef.current = onSelect;
  const reducedRef = useRef(false);
  /* The first active value is the opening card, not a choice the user made, so
     it must not yank the camera. Recorded here rather than in the effect body
     so the very first render is the only one that is treated as initial. */
  const didEstablish = useRef(false);
  /** Index under the cursor, or null. Component scope rather than local to the
   *  scene effect because the repaint effect below needs to know it: a label
   *  belongs on screen when its place is selected *or* hovered, and the two
   *  live in different effects. */
  const hoveredRef = useRef<number | null>(null);

  /* Cesium only in the browser, and only on this page: the library plus ~8MB of
     runtime assets, which nothing above the fold on any other route should pay. */
  useEffect(() => {
    let cancelled = false;
    loadCesium()
      .then((mod) => {
        if (!cancelled) setCesium(mod);
      })
      .catch((err: Error) => {
        if (!cancelled) console.error("[globe]", err.message);
      });
    return () => {
      cancelled = true;
    };
  }, []);

  useEffect(() => {
    const mq = window.matchMedia("(prefers-reduced-motion: reduce)");
    const on = () => {
      reducedRef.current = mq.matches;
    };
    on();
    mq.addEventListener("change", on);
    return () => mq.removeEventListener("change", on);
  }, []);

  /* Build the scene once. */
  useEffect(() => {
    const box = boxRef.current;
    if (!cesium || !box) return;

    const {
      Viewer,
      Cartesian2,
      Cartesian3,
      Color,
      EllipsoidTerrainProvider,
      ImageryLayer,
      Ion,
      IonImageryProvider,
      OpenStreetMapImageryProvider,
      ScreenSpaceEventHandler,
      ScreenSpaceEventType,
      HorizontalOrigin,
      LabelStyle,
      VerticalOrigin,
    } = cesium;

    /* Always assign, never conditionally. Cesium ships with a placeholder
       token already in Ion.defaultAccessToken, so leaving it alone makes Cesium
       believe it is ion-backed and paint an "API KEY REQUIRED" credit logo
       across the planet -- even though nothing here is ion-sourced. Clearing it
       when there is no real token is what removes the watermark. */
    Ion.defaultAccessToken = TOKEN ?? "";

    /* Viewer wants an ImageryLayer, not a provider, and the ion provider is
       built asynchronously. fromProviderAsync is the documented bridge between
       the two, and it is why the ion branch below is not awaited. */
    /*
     * OSM's standard tiles: no key, no account, and the only no-key option
     * verified to serve actual cartography rather than a watermark.
     *
     * CARTO's dark_all basemap was tried first because it is the right palette
     * for this band and needs no key -- it does not any more. It now answers
     * every tile with HTTP 200 and a "API KEY REQUIRED" watermark baked into
     * the image, which is worse than an error: nothing logs, the credit text
     * stays empty, and the planet ends up wrapped in repeated watermark tiles.
     *
     * Set NEXT_PUBLIC_CESIUM_ION_TOKEN for real satellite imagery, which is
     * the intended look and the reason to want Cesium over the old texture.
     */
    const baseLayer = TOKEN
      ? ImageryLayer.fromProviderAsync(IonImageryProvider.fromAssetId(ION_ASSET))
      : ImageryLayer.fromProviderAsync(
          Promise.resolve(
            new OpenStreetMapImageryProvider({
              url: "https://tile.openstreetmap.org/",
              credit:
                'Map data &copy; <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a> contributors',
            }),
          ),
        );

    const viewer = new Viewer(box, {
      baseLayer,
      terrainProvider: new EllipsoidTerrainProvider(),
      // Every widget stripped: this is a backdrop for a list, not a GIS app.
      baseLayerPicker: false,
      geocoder: false,
      homeButton: false,
      sceneModePicker: false,
      navigationHelpButton: false,
      animation: false,
      timeline: false,
      fullscreenButton: false,
      infoBox: false,
      selectionIndicator: false,
    });

    viewer.scene.globe.baseColor = Color.fromCssColorString("#0b1524");
    viewer.scene.backgroundColor = Color.fromCssColorString("#05070c");
    viewer.scene.globe.showGroundAtmosphere = true;
    // At globe altitude a bright ground atmosphere washes the whole disc to
    // pale blue and flattens the limb, so it is dialled right down.
    viewer.scene.globe.atmosphereBrightnessShift = -0.35;
    viewer.scene.fog.enabled = true;
    // Sun lighting would black out half the planet, and the point is browsing
    // places rather than watching a day go by.
    viewer.scene.globe.enableLighting = false;

    byEntityId.current.clear();
    byIndex.current.clear();

    for (const pin of pins) {
      const entity = viewer.entities.add({
        name: pin.name,
        position: Cartesian3.fromDegrees(pin.lng, pin.lat),
        point: {
          // A 2px outline on a 7px dot is mostly outline, so the pins read as
          // hollow rings rather than dots. 9px with a hairline keeps them solid.
          pixelSize: 9,
          color: Color.fromCssColorString("#7fc4e8").withAlpha(0.95),
          outlineColor: Color.fromCssColorString("#05070c"),
          outlineWidth: 1,
          // Drawn through the globe, so a pin on the far side is still
          // clickable instead of waiting for the planet to turn.
          disableDepthTestDistance: Number.POSITIVE_INFINITY,
        },
        label: {
          text: pin.name,
          font: "600 12px system-ui, sans-serif",
          fillColor: Color.fromCssColorString("#e8edf5"),
          outlineColor: Color.fromCssColorString("#05070c"),
          outlineWidth: 3,
          style: LabelStyle.FILL_AND_OUTLINE,
          showBackground: true,
          backgroundColor: Color.fromCssColorString("#05070c").withAlpha(0.82),
          backgroundPadding: new Cartesian2(7, 4),
          pixelOffset: new Cartesian2(0, -18),
          verticalOrigin: VerticalOrigin.BOTTOM,
          horizontalOrigin: HorizontalOrigin.CENTER,
          // 100 labels at once is unreadable; the selected one and the hovered
          // one are shown, everything else stays quiet.
          show: false,
          disableDepthTestDistance: Number.POSITIVE_INFINITY,
        },
      });
      byEntityId.current.set(entity.id, pin.index);
      byIndex.current.set(pin.index, entity);
    }

    /* ---------------------------------------------------------------- input */

    const handler = new ScreenSpaceEventHandler(viewer.scene.canvas);
    const canvas = viewer.scene.canvas;

    handler.setInputAction((movement: { position: unknown }) => {
      const picked = viewer.scene.pick(movement.position as never);
      const id = picked?.id?.id as string | undefined;
      if (id != null && byEntityId.current.has(id)) {
        onSelectRef.current(byEntityId.current.get(id)!);
      }
    }, ScreenSpaceEventType.LEFT_CLICK);

    handler.setInputAction((movement: { endPosition: unknown }) => {
      const picked = viewer.scene.pick(movement.endPosition as never);
      const id = picked?.id?.id as string | undefined;
      const next = id != null && byEntityId.current.has(id) ? byEntityId.current.get(id)! : null;
      if (next === hoveredRef.current) return;
      hoveredRef.current = next;
      // Repaint straight away rather than waiting for a selection change, so
      // labels appear and disappear under the cursor.
      for (const [index, entity] of byIndex.current) {
        setProp(entity.label?.show, index === next);
      }
      canvas.style.cursor = next != null ? "pointer" : "";
    }, ScreenSpaceEventType.MOUSE_MOVE);

    /* Idle turn. Cesium has no built-in auto-rotate -- `shouldAnimate` is not
       a Viewer option -- so the camera is nudged around its own axis from
       preRender, and only while the user has been still for IDLE_MS. Without
       the idle check it fights every drag. */
    let lastInput = performance.now();
    const mark = () => {
      lastInput = performance.now();
    };
    canvas.addEventListener("wheel", mark, { passive: true });
    canvas.addEventListener("pointerdown", mark);

    let lastFrame = performance.now();
    const spin = () => {
      const now = performance.now();
      const dt = Math.min((now - lastFrame) / 1000, 0.1);
      lastFrame = now;
      if (reducedRef.current) return;
      if (now - lastInput < IDLE_MS) return;
      viewer.scene.camera.rotate(Cartesian3.UNIT_Z, (SPIN_DEG_PER_SEC * Math.PI) / 180 * dt);
    };
    viewer.scene.preRender.addEventListener(spin);

    viewerRef.current = viewer;
    setReady(true);

    return () => {
      setReady(false);
      viewer.scene.preRender.removeEventListener(spin);
      canvas.removeEventListener("wheel", mark);
      canvas.removeEventListener("pointerdown", mark);
      hoveredRef.current = null;
      handler.destroy();
      viewer.destroy();
      viewerRef.current = null;
      byEntityId.current.clear();
      byIndex.current.clear();
    };
    /* Built once. Rebuilding on pins/active would tear down the WebGL context
       on every selection, which is the fastest way to make a globe stutter. */
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [cesium]);

  /* Camera follows the selection. */
  useEffect(() => {
    const viewer = viewerRef.current;
    if (!viewer || !cesium) return;
    if (active == null) return;
    const pin = pins.find((p) => p.index === active);
    if (!pin) return;

    const { Cartesian3, Math: CMath } = cesium;

    if (!didEstablish.current && !focusOnMount) {
      /* Open on the whole planet, centred a little off the first place so it
         is visibly on the near side rather than dead centre. */
      didEstablish.current = true;
      viewer.camera.setView({
        destination: Cartesian3.fromDegrees(pin.lng * 0.4, 18, ESTABLISH_HEIGHT),
        orientation: { heading: 0, pitch: CMath.toRadians(-90), roll: 0 },
      });
      return;
    }

    const destination = Cartesian3.fromDegrees(pin.lng, pin.lat, FOCUS_HEIGHT);
    // A slight tilt rather than straight down: the curve at the limb is most
    // of what makes it read as a globe.
    const orientation = { heading: 0, pitch: CMath.toRadians(-62), roll: 0 };

    if (reducedRef.current) {
      viewer.camera.setView({ destination, orientation });
    } else {
      viewer.camera.flyTo({ destination, orientation, duration: 1.1 });
    }
  }, [active, cesium, pins, focusOnMount]);

  /* Repaint the selected pin so the list and the globe visibly agree. */
  useEffect(() => {
    if (!cesium) return;
    const { Color } = cesium;
    for (const [index, entity] of byIndex.current) {
      const on = index === active;
      setProp(
        entity.point?.color,
        Color.fromCssColorString(on ? "#f5a623" : "#8fb8d8").withAlpha(0.92),
      );
      setProp(entity.point?.pixelSize, on ? 14 : 9);
      // A label belongs on screen for the selected place or the hovered one,
      // and for nothing else -- otherwise every place you have ever visited
      // keeps its caption and the globe silts up with text.
      setProp(entity.label?.show, on || hoveredRef.current === index);
    }
  }, [active, cesium]);

  return (
    <div className="worldglobe" ref={boxRef}>
      <p className="worldglobe__hint" data-ready={ready ? "true" : "false"}>
        {ready
          ? `${pins.length} places plotted · search the list, or click a pin`
          : "Loading the globe…"}
      </p>
    </div>
  );
}

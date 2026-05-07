import {
  CaptureUpdateAction,
  viewportCoordsToSceneCoords,
} from "@excalidraw/excalidraw";
import { registerPlugin } from "@capacitor/core";
import {
  getBoundTextElementId,
  getElementsInGroup,
  getNonDeletedElements,
  hasBoundTextElement,
  isBoundToContainer,
  newElementWith,
  newFreeDrawElement,
  syncInvalidIndices,
} from "@excalidraw/element";
import { eraserTest } from "@excalidraw/excalidraw/eraser";
import { lineSegment, pointFrom } from "@excalidraw/math";

import type { LocalPoint } from "@excalidraw/math";
import type { ExcalidrawImperativeAPI } from "@excalidraw/excalidraw/types";
import type {
  ElementsMap,
  ExcalidrawElement,
  OrderedExcalidrawElement,
} from "@excalidraw/element/types";
import type { GlobalPoint } from "@excalidraw/math/types";

import type { PluginListenerHandle } from "@capacitor/core";

type OnyxPoint = {
  x: number;
  y: number;
  p?: number;
};

type SceneStrokePoint = {
  x: number;
  y: number;
  p?: number;
};

type OnyxStrokePayload = {
  tool?: "pen" | "eraser";
  points?: OnyxPoint[];
  surfaceWidth?: number;
  surfaceHeight?: number;
  generation?: number;
};

type NativeRect = {
  left: number;
  top: number;
  right: number;
  bottom: number;
};

type NativeHandoffOptions = NativeRect & {
  expectedGeneration?: number;
};

type NativeHandoffResult = {
  didRun?: boolean;
};

type OnyxPenPlugin = {
  enable: () => Promise<void>;
  disable: () => Promise<void>;
  clear: (options?: NativeHandoffOptions) => Promise<NativeHandoffResult>;
  refreshWebViewRegion: (options?: NativeRect) => Promise<void>;
  repaintWebViewHandwriting: (
    options?: NativeHandoffOptions,
  ) => Promise<NativeHandoffResult>;
  setStyle: (options: {
    strokeWidth: number;
    strokeColor: string;
    opacity: number;
    pressureSensitive: boolean;
  }) => Promise<void>;
  setExcludedRects: (options: {
    rects: Array<{ left: number; top: number; right: number; bottom: number }>;
    viewportWidth: number;
    viewportHeight: number;
  }) => Promise<void>;
  addListener: (
    eventName: "onyxStroke" | "onyxPointerDown",
    listenerFunc: (payload: OnyxStrokePayload) => void,
  ) => Promise<PluginListenerHandle>;
};

type OnyxPenBridgeOptions = {
  onElementsChange?: (elements: readonly OrderedExcalidrawElement[]) => void;
};

const OnyxPen = registerPlugin<OnyxPenPlugin>("OnyxPen");
const CONVERT_IDLE_MS = 500;
const FLUSH_IDLE_TIMEOUT_MS = 350;
const MAX_STROKES_PER_FLUSH = 12;
const MAX_STAGED_STROKES_PER_SCENE_UPDATE = 96;
const STAGED_STROKE_APPLY_QUIET_MS = 1600;
const STAGED_STROKE_APPLY_IDLE_TIMEOUT_MS = 5000;
const THIN_STROKE_WIDTH = 0.45;
const BOLD_STROKE_WIDTH = 0.8;
const EXTRA_BOLD_STROKE_WIDTH = 1.35;
const MIN_ONYX_PRESSURE = 0.08;
const MAX_ONYX_PRESSURE = 1;
const MIN_STROKE_POINT_DISTANCE = 0.16;
const STROKE_SIMPLIFICATION_EPSILON = 0.16;
const ONYX_FREEDRAW_SMOOTHING = 0.28;
const ONYX_FREEDRAW_STREAMLINE = 0.12;
const NATIVE_PRESSURE_PREVIEW_WIDTH_SCALE = 1.4;
const MAX_POINTS_PER_STROKE = 800;
const MAX_SIMPLIFICATION_PASSES = 4;
const CLEAR_REGION_PADDING = 48;
const WEBVIEW_RENDER_SETTLE_MS = 48;
const NATIVE_CLEAR_AFTER_REPAINT_MS = 70;
const FINAL_REPAINT_AFTER_CLEAR_MS = 170;
const SCENE_RESET_EVENT = "booxdraw:scene-reset";
let lastExcludedRectsSignature = "";
let lastStyleSignature = "";
let pendingOnyxSceneUpdateCount = 0;

export const consumePendingOnyxSceneUpdate = () => {
  if (pendingOnyxSceneUpdateCount <= 0) {
    return false;
  }

  pendingOnyxSceneUpdateCount--;
  return true;
};

type IdleCallbackHandleType = "idle" | "timeout";

type WindowWithIdleCallback = Window & {
  requestIdleCallback?: (
    callback: IdleRequestCallback,
    options?: IdleRequestOptions,
  ) => number;
  cancelIdleCallback?: (handle: number) => void;
};

type NativeInkHandoffState = {
  deferredRect: NativeRect | null;
  scheduledRect: NativeRect | null;
  strokeGeneration: number;
  timeouts: number[];
};

type StagedStrokeBatch = {
  elements: ExcalidrawElement[];
  nativeClearRect: NativeRect | null;
  nativeStrokeGeneration: number;
  applyDelayTimeout: number;
  applyIdleCallback: number;
};

export const connectOnyxPenBridge = (
  excalidrawAPI: ExcalidrawImperativeAPI,
  options: OnyxPenBridgeOptions = {},
) => {
  let disposed = false;
  let listener: PluginListenerHandle | null = null;
  let pointerDownListener: PluginListenerHandle | null = null;
  let excludedRectsInterval = 0;
  let styleInterval = 0;
  let flushTimeout = 0;
  let flushIdleCallback = 0;
  let flushIdleCallbackType: IdleCallbackHandleType | null = null;
  const nativeInkHandoff: NativeInkHandoffState = {
    deferredRect: null,
    scheduledRect: null,
    strokeGeneration: 0,
    timeouts: [],
  };
  const stagedStrokeBatch: StagedStrokeBatch = {
    elements: [],
    nativeClearRect: null,
    nativeStrokeGeneration: 0,
    applyDelayTimeout: 0,
    applyIdleCallback: 0,
  };
  const pendingStrokes: OnyxStrokePayload[] = [];

  const attach = async () => {
    try {
      listener = await OnyxPen.addListener("onyxStroke", (payload) => {
        if (!disposed) {
          queueStroke(excalidrawAPI, payload, pendingStrokes, options);
        }
      });
      pointerDownListener = await OnyxPen.addListener(
        "onyxPointerDown",
        (payload) => {
          if (!disposed) {
            nativeInkHandoff.strokeGeneration =
              getPayloadGeneration(payload) ??
              nativeInkHandoff.strokeGeneration + 1;
            if (flushTimeout) {
              window.clearTimeout(flushTimeout);
              flushTimeout = 0;
            }
            cancelFlushIdleCallback();
            cancelStagedStrokeApply();
            excalidrawAPI.updateScene({
              appState: {
                openMenu: null,
                openPopup: null,
                showToolSettings: false,
              },
              captureUpdate: CaptureUpdateAction.NEVER,
            });
          }
        },
      );
      await OnyxPen.enable();
      window.__ONYX_NATIVE_PEN__ = true;
      excalidrawAPI.updateScene({
        appState: {
          penDetected: true,
          penMode: true,
        },
        captureUpdate: CaptureUpdateAction.NEVER,
      });
      updateNativeExcludedRects();
      updateNativeStyle(excalidrawAPI);
      excludedRectsInterval = window.setInterval(
        updateNativeExcludedRects,
        750,
      );
      styleInterval = window.setInterval(
        () => updateNativeStyle(excalidrawAPI),
        250,
      );
      window.addEventListener(SCENE_RESET_EVENT, handleSceneReset);
    } catch (error) {
      console.info("OnyxPen bridge unavailable", error);
    }
  };

  const handleSceneReset = () => {
    pendingStrokes.length = 0;
    cancelScheduledFlush();
    clearStagedStrokeBatch();
    clearNativeInkHandoffTimeouts(nativeInkHandoff);
    nativeInkHandoff.deferredRect = null;
    nativeInkHandoff.scheduledRect = null;
    nativeInkHandoff.strokeGeneration++;
    OnyxPen.clear().catch(() => {
      // Native plugin is only available inside the Android shell.
    });
  };

  const queueStroke = (
    excalidrawAPI: ExcalidrawImperativeAPI,
    payload: OnyxStrokePayload,
    pendingStrokes: OnyxStrokePayload[],
    options: OnyxPenBridgeOptions,
  ) => {
    pendingStrokes.push(payload);
    cancelScheduledFlush();
    flushTimeout = window.setTimeout(() => {
      flushTimeout = 0;
      scheduleFlushWhenIdle();
    }, CONVERT_IDLE_MS);
  };

  const scheduleFlushWhenIdle = () => {
    const runFlush = () => {
      flushIdleCallback = 0;
      flushIdleCallbackType = null;
      if (pendingStrokes.length) {
        flushStrokes(
          excalidrawAPI,
          pendingStrokes,
          options,
          nativeInkHandoff,
          stagedStrokeBatch,
          applyStagedStrokes,
          scheduleStagedStrokeApply,
          scheduleFlushWhenIdle,
        );
      }
    };
    const idleWindow = window as WindowWithIdleCallback;
    if (idleWindow.requestIdleCallback) {
      flushIdleCallback = idleWindow.requestIdleCallback(runFlush, {
        timeout: FLUSH_IDLE_TIMEOUT_MS,
      });
      flushIdleCallbackType = "idle";
      return;
    }

    flushIdleCallback = window.setTimeout(runFlush, 0);
    flushIdleCallbackType = "timeout";
  };

  const cancelFlushIdleCallback = () => {
    if (!flushIdleCallback) {
      return;
    }
    const idleWindow = window as WindowWithIdleCallback;
    if (flushIdleCallbackType === "idle" && idleWindow.cancelIdleCallback) {
      idleWindow.cancelIdleCallback(flushIdleCallback);
    } else {
      window.clearTimeout(flushIdleCallback);
    }
    flushIdleCallback = 0;
    flushIdleCallbackType = null;
  };

  const cancelScheduledFlush = () => {
    if (flushTimeout) {
      window.clearTimeout(flushTimeout);
      flushTimeout = 0;
    }
    cancelFlushIdleCallback();
  };

  const scheduleStagedStrokeApply = () => {
    if (
      stagedStrokeBatch.applyDelayTimeout ||
      stagedStrokeBatch.applyIdleCallback
    ) {
      return;
    }

    stagedStrokeBatch.applyDelayTimeout = window.setTimeout(() => {
      stagedStrokeBatch.applyDelayTimeout = 0;

      const idleWindow = window as WindowWithIdleCallback;
      if (idleWindow.requestIdleCallback) {
        const idleCallback = idleWindow.requestIdleCallback(
          () => {
            if (stagedStrokeBatch.applyIdleCallback !== idleCallback) {
              return;
            }
            stagedStrokeBatch.applyIdleCallback = 0;
            applyStagedStrokes();
          },
          { timeout: STAGED_STROKE_APPLY_IDLE_TIMEOUT_MS },
        );
        stagedStrokeBatch.applyIdleCallback = idleCallback;
        return;
      }

      applyStagedStrokes();
    }, STAGED_STROKE_APPLY_QUIET_MS);
  };

  const cancelStagedStrokeApply = () => {
    if (stagedStrokeBatch.applyDelayTimeout) {
      window.clearTimeout(stagedStrokeBatch.applyDelayTimeout);
      stagedStrokeBatch.applyDelayTimeout = 0;
    }

    if (stagedStrokeBatch.applyIdleCallback) {
      const idleWindow = window as WindowWithIdleCallback;
      if (idleWindow.cancelIdleCallback) {
        idleWindow.cancelIdleCallback(stagedStrokeBatch.applyIdleCallback);
      }
      stagedStrokeBatch.applyIdleCallback = 0;
    }
  };

  const clearStagedStrokeBatch = () => {
    cancelStagedStrokeApply();
    stagedStrokeBatch.elements = [];
    stagedStrokeBatch.nativeClearRect = null;
    stagedStrokeBatch.nativeStrokeGeneration = 0;
  };

  const applyStagedStrokes = () => {
    cancelStagedStrokeApply();
    if (!stagedStrokeBatch.elements.length) {
      return;
    }

    const stagedElements = stagedStrokeBatch.elements;
    const nativeClearRect = stagedStrokeBatch.nativeClearRect;
    const nativeStrokeGeneration = stagedStrokeBatch.nativeStrokeGeneration;
    stagedStrokeBatch.elements = [];
    stagedStrokeBatch.nativeClearRect = null;
    stagedStrokeBatch.nativeStrokeGeneration = 0;

    const orderedElements = syncInvalidIndices([
      ...excalidrawAPI.getSceneElementsIncludingDeleted(),
      ...stagedElements,
    ]);

    pendingOnyxSceneUpdateCount++;
    excalidrawAPI.updateScene({
      elements: orderedElements,
      appState: {
        selectedElementIds: {},
      },
      captureUpdate: CaptureUpdateAction.IMMEDIATELY,
    });
    options.onElementsChange?.(orderedElements);
    scheduleNativeInkHandoff(
      nativeClearRect,
      nativeStrokeGeneration,
      nativeInkHandoff,
    );
  };

  attach();

  return () => {
    disposed = true;
    if (excludedRectsInterval) {
      window.clearInterval(excludedRectsInterval);
    }
    if (styleInterval) {
      window.clearInterval(styleInterval);
    }
    if (flushTimeout) {
      window.clearTimeout(flushTimeout);
    }
    cancelFlushIdleCallback();
    clearStagedStrokeBatch();
    clearNativeInkHandoffTimeouts(nativeInkHandoff);
    window.removeEventListener(SCENE_RESET_EVENT, handleSceneReset);
    listener?.remove();
    pointerDownListener?.remove();
    window.__ONYX_NATIVE_PEN__ = false;
    OnyxPen.disable().catch(() => {
      // Native plugin is only available inside the Android shell.
    });
  };
};

const flushStrokes = (
  excalidrawAPI: ExcalidrawImperativeAPI,
  pendingStrokes: OnyxStrokePayload[],
  options: OnyxPenBridgeOptions,
  nativeInkHandoff: NativeInkHandoffState,
  stagedStrokeBatch: StagedStrokeBatch,
  applyStagedStrokes: () => void,
  scheduleStagedStrokeApply: () => void,
  onPendingStrokesRemaining?: () => void,
) => {
  const payloads = pendingStrokes.splice(0, MAX_STROKES_PER_FLUSH);
  const hasMorePendingStrokes = pendingStrokes.length > 0;
  const newElements: ExcalidrawElement[] = [];
  const nativeClearRect = mergeNativeRects(
    nativeInkHandoff.deferredRect,
    getNativeStrokeBounds(payloads),
  );
  const nativeStrokeGeneration = getNativeStrokeGeneration(
    payloads,
    nativeInkHandoff.strokeGeneration,
  );
  nativeInkHandoff.deferredRect = null;
  const appState = excalidrawAPI.getAppState();
  const hasEraserStroke = payloads.some(
    (payload) =>
      payload.tool === "eraser" || appState.activeTool.type === "eraser",
  );

  if (!hasEraserStroke) {
    for (const payload of payloads) {
      const element = createStrokeElement(excalidrawAPI, payload);
      if (element) {
        newElements.push(element);
      }
    }

    if (newElements.length) {
      stagedStrokeBatch.elements.push(...newElements);
      stagedStrokeBatch.nativeClearRect = mergeNativeRects(
        stagedStrokeBatch.nativeClearRect,
        nativeClearRect,
      );
      stagedStrokeBatch.nativeStrokeGeneration = Math.max(
        stagedStrokeBatch.nativeStrokeGeneration,
        nativeStrokeGeneration,
      );

      if (
        !hasMorePendingStrokes ||
        stagedStrokeBatch.elements.length >= MAX_STAGED_STROKES_PER_SCENE_UPDATE
      ) {
        scheduleStagedStrokeApply();
      }
    } else {
      scheduleNativeInkHandoff(
        nativeClearRect,
        nativeStrokeGeneration,
        nativeInkHandoff,
      );
    }

    if (hasMorePendingStrokes) {
      onPendingStrokesRemaining?.();
    }
    return;
  }

  applyStagedStrokes();
  let elements: readonly ExcalidrawElement[] =
    excalidrawAPI.getSceneElementsIncludingDeleted();
  let didChange = false;
  for (const payload of payloads) {
    const effectiveTool =
      payload.tool === "eraser" || appState.activeTool.type === "eraser"
        ? "eraser"
        : "pen";

    if (effectiveTool === "eraser") {
      const nextElements = eraseElements(excalidrawAPI, elements, payload);
      if (nextElements !== elements) {
        elements = nextElements;
        didChange = true;
      }
      continue;
    }

    const element = createStrokeElement(excalidrawAPI, payload);
    if (element) {
      newElements.push(element);
    }
  }

  if (newElements.length) {
    elements = [...elements, ...newElements];
    didChange = true;
  }

  if (!didChange) {
    scheduleNativeInkHandoff(
      nativeClearRect,
      nativeStrokeGeneration,
      nativeInkHandoff,
    );
    if (hasMorePendingStrokes) {
      onPendingStrokesRemaining?.();
    }
    return;
  }

  const orderedElements = syncInvalidIndices(elements);

  pendingOnyxSceneUpdateCount++;
  excalidrawAPI.updateScene({
    elements: orderedElements,
    appState: {
      selectedElementIds: {},
    },
    captureUpdate: CaptureUpdateAction.IMMEDIATELY,
  });
  options.onElementsChange?.(orderedElements);
  scheduleNativeInkHandoff(
    nativeClearRect,
    nativeStrokeGeneration,
    nativeInkHandoff,
  );
  if (hasMorePendingStrokes) {
    onPendingStrokesRemaining?.();
  }
};

const scheduleNativeInkHandoff = (
  nativeClearRect: NativeRect | null,
  nativeStrokeGeneration: number,
  nativeInkHandoff: NativeInkHandoffState,
) => {
  if (!nativeClearRect) {
    return;
  }

  nativeInkHandoff.scheduledRect = mergeNativeRects(
    nativeInkHandoff.scheduledRect,
    nativeClearRect,
  );
  const scheduledRect = nativeInkHandoff.scheduledRect;
  if (!scheduledRect) {
    return;
  }

  clearNativeInkHandoffTimeouts(nativeInkHandoff);
  const scheduledGeneration = nativeStrokeGeneration;
  const addTimeout = (callback: () => void, delay: number) => {
    const timeout = window.setTimeout(() => {
      nativeInkHandoff.timeouts = nativeInkHandoff.timeouts.filter(
        (candidate) => candidate !== timeout,
      );
      callback();
    }, delay);
    nativeInkHandoff.timeouts.push(timeout);
  };

  addTimeout(() => {
    OnyxPen.repaintWebViewHandwriting(
      withExpectedGeneration(scheduledRect, scheduledGeneration),
    ).catch(() => {
      // Native plugin is only available inside the Android shell.
    });
  }, WEBVIEW_RENDER_SETTLE_MS);

  addTimeout(() => {
    if (nativeInkHandoff.strokeGeneration !== scheduledGeneration) {
      nativeInkHandoff.deferredRect = mergeNativeRects(
        nativeInkHandoff.deferredRect,
        scheduledRect,
      );
      if (nativeInkHandoff.scheduledRect === scheduledRect) {
        nativeInkHandoff.scheduledRect = null;
      }
      return;
    }

    if (nativeInkHandoff.scheduledRect === scheduledRect) {
      nativeInkHandoff.scheduledRect = null;
    }
    OnyxPen.clear(withExpectedGeneration(scheduledRect, scheduledGeneration))
      .then((result) => {
        if (result?.didRun === false) {
          nativeInkHandoff.deferredRect = mergeNativeRects(
            nativeInkHandoff.deferredRect,
            scheduledRect,
          );
        }
      })
      .catch(() => {
        // Native plugin is only available inside the Android shell.
      });
  }, WEBVIEW_RENDER_SETTLE_MS + NATIVE_CLEAR_AFTER_REPAINT_MS);

  addTimeout(() => {
    OnyxPen.repaintWebViewHandwriting(
      withExpectedGeneration(scheduledRect, scheduledGeneration),
    ).catch(() => {
      // Native plugin is only available inside the Android shell.
    });
  }, WEBVIEW_RENDER_SETTLE_MS + NATIVE_CLEAR_AFTER_REPAINT_MS + FINAL_REPAINT_AFTER_CLEAR_MS);
};

const withExpectedGeneration = (
  rect: NativeRect,
  expectedGeneration: number,
): NativeHandoffOptions => {
  if (!Number.isFinite(expectedGeneration) || expectedGeneration <= 0) {
    return { ...rect };
  }
  return {
    ...rect,
    expectedGeneration,
  };
};

const clearNativeInkHandoffTimeouts = (
  nativeInkHandoff: NativeInkHandoffState,
) => {
  for (const timeout of nativeInkHandoff.timeouts) {
    window.clearTimeout(timeout);
  }
  nativeInkHandoff.timeouts = [];
};

const mergeNativeRects = (
  first: NativeRect | null,
  second: NativeRect | null,
): NativeRect | null => {
  if (!first) {
    return second ? { ...second } : null;
  }
  if (!second) {
    return { ...first };
  }

  return {
    left: Math.min(first.left, second.left),
    top: Math.min(first.top, second.top),
    right: Math.max(first.right, second.right),
    bottom: Math.max(first.bottom, second.bottom),
  };
};

const getNativeStrokeBounds = (
  payloads: OnyxStrokePayload[],
): NativeRect | null => {
  let left = Infinity;
  let top = Infinity;
  let right = -Infinity;
  let bottom = -Infinity;
  let surfaceWidth = 0;
  let surfaceHeight = 0;

  for (const payload of payloads) {
    const points = payload.points?.filter(isValidPoint) ?? [];
    if (!points.length) {
      continue;
    }
    surfaceWidth = Math.max(surfaceWidth, payload.surfaceWidth ?? 0);
    surfaceHeight = Math.max(surfaceHeight, payload.surfaceHeight ?? 0);

    for (const point of points) {
      left = Math.min(left, point.x);
      top = Math.min(top, point.y);
      right = Math.max(right, point.x);
      bottom = Math.max(bottom, point.y);
    }
  }

  if (
    !Number.isFinite(left) ||
    !Number.isFinite(top) ||
    !Number.isFinite(right) ||
    !Number.isFinite(bottom)
  ) {
    return null;
  }

  return {
    left: Math.max(0, Math.floor(left - CLEAR_REGION_PADDING)),
    top: Math.max(0, Math.floor(top - CLEAR_REGION_PADDING)),
    right:
      surfaceWidth > 0
        ? Math.min(surfaceWidth, Math.ceil(right + CLEAR_REGION_PADDING))
        : Math.ceil(right + CLEAR_REGION_PADDING),
    bottom:
      surfaceHeight > 0
        ? Math.min(surfaceHeight, Math.ceil(bottom + CLEAR_REGION_PADDING))
        : Math.ceil(bottom + CLEAR_REGION_PADDING),
  };
};

const getNativeStrokeGeneration = (
  payloads: OnyxStrokePayload[],
  fallbackGeneration: number,
) => {
  let generation = fallbackGeneration;
  for (const payload of payloads) {
    generation = Math.max(generation, getPayloadGeneration(payload) ?? 0);
  }
  return generation;
};

const getPayloadGeneration = (payload: OnyxStrokePayload | undefined) => {
  const generation = payload?.generation;
  return typeof generation === "number" && Number.isFinite(generation)
    ? generation
    : null;
};

const createStrokeElement = (
  excalidrawAPI: ExcalidrawImperativeAPI,
  payload: OnyxStrokePayload,
) => {
  const rawPoints = payload.points?.filter(isValidPoint) ?? [];
  if (rawPoints.length < 2) {
    return null;
  }

  const appState = excalidrawAPI.getAppState();
  const scenePoints = simplifyStrokePoints(
    rawPoints.map((point) => {
      const client = nativePointToClientPoint(point, payload);
      const scenePoint = viewportCoordsToSceneCoords(client, appState);
      return {
        x: scenePoint.x,
        y: scenePoint.y,
        p: point.p,
      };
    }),
    appState.zoom.value,
  );

  if (scenePoints.length < 2) {
    return null;
  }

  const originX = scenePoints[0].x;
  const originY = scenePoints[0].y;
  if (!Number.isFinite(originX) || !Number.isFinite(originY)) {
    console.warn("OnyxPen rejected stroke with invalid origin", {
      originX,
      originY,
      appState,
      payload,
    });
    return null;
  }

  const localPoints = scenePoints.map((point) =>
    pointFrom<LocalPoint>(point.x - originX, point.y - originY),
  );

  let minX = localPoints[0][0];
  let minY = localPoints[0][1];
  let maxX = localPoints[0][0];
  let maxY = localPoints[0][1];
  for (const point of scenePoints) {
    const x = point.x - originX;
    const y = point.y - originY;
    minX = Math.min(minX, x);
    minY = Math.min(minY, y);
    maxX = Math.max(maxX, x);
    maxY = Math.max(maxY, y);
  }

  const strokeWidth = getOnyxStrokeWidth(appState.currentItemStrokeWidth);
  const pressures = normalizePressures(scenePoints, strokeWidth);
  const strokeColor = normalizeStrokeColor(appState.currentItemStrokeColor);

  console.info(
    [
      "OnyxPen stroke style",
      `color=${strokeColor}`,
      "opacity=100",
      `width=${strokeWidth}`,
      `pressureMin=${Math.min(...pressures).toFixed(3)}`,
      `pressureMax=${Math.max(...pressures).toFixed(3)}`,
    ].join(" "),
  );

  return newFreeDrawElement({
    type: "freedraw",
    x: originX,
    y: originY,
    width: maxX - minX,
    height: maxY - minY,
    strokeColor,
    backgroundColor: appState.currentItemBackgroundColor,
    fillStyle: appState.currentItemFillStyle,
    strokeWidth,
    strokeStyle: appState.currentItemStrokeStyle,
    roughness: appState.currentItemRoughness,
    opacity: 100,
    roundness: null,
    locked: false,
    points: localPoints,
    pressures,
    simulatePressure: false,
    customData: {
      freedrawOptions: {
        smoothing: ONYX_FREEDRAW_SMOOTHING,
        streamline: ONYX_FREEDRAW_STREAMLINE,
      },
    },
  });
};

const eraseElements = (
  excalidrawAPI: ExcalidrawImperativeAPI,
  elements: readonly ExcalidrawElement[],
  payload: OnyxStrokePayload,
) => {
  const scenePoints = getSceneStrokePoints(excalidrawAPI, payload);
  if (scenePoints.length < 2) {
    return elements;
  }

  const zoom = excalidrawAPI.getAppState().zoom.value;
  const elementsMap = new Map(
    elements.map((element) => [element.id, element]),
  ) as ElementsMap;
  const candidateElements = getNonDeletedElements(elements).filter(
    (element) => !element.locked,
  );
  const elementIdsToErase = new Set<ExcalidrawElement["id"]>();
  const groupIdsToErase = new Set<string>();

  for (let index = 1; index < scenePoints.length; index++) {
    const segment = lineSegment<GlobalPoint>(
      pointFrom<GlobalPoint>(
        scenePoints[index - 1].x,
        scenePoints[index - 1].y,
      ),
      pointFrom<GlobalPoint>(scenePoints[index].x, scenePoints[index].y),
    );

    for (const element of candidateElements) {
      if (elementIdsToErase.has(element.id)) {
        continue;
      }
      if (!eraserTest(segment, element, elementsMap, zoom)) {
        continue;
      }

      const shallowestGroupId = element.groupIds.at(-1);
      if (shallowestGroupId && !groupIdsToErase.has(shallowestGroupId)) {
        for (const elementInGroup of getElementsInGroup(
          elementsMap,
          shallowestGroupId,
        )) {
          elementIdsToErase.add(elementInGroup.id);
        }
        groupIdsToErase.add(shallowestGroupId);
      }

      if (hasBoundTextElement(element)) {
        const boundTextId = getBoundTextElementId(element);
        if (boundTextId) {
          elementIdsToErase.add(boundTextId);
        }
      }

      if (isBoundToContainer(element)) {
        elementIdsToErase.add(element.containerId);
      }

      elementIdsToErase.add(element.id);
    }
  }

  if (!elementIdsToErase.size) {
    return elements;
  }

  console.info(`OnyxPen eraser deleted=${elementIdsToErase.size}`);
  return elements.map((element) =>
    elementIdsToErase.has(element.id) ||
    (element.frameId && elementIdsToErase.has(element.frameId)) ||
    (isBoundToContainer(element) && elementIdsToErase.has(element.containerId))
      ? (newElementWith(element, {
          isDeleted: true,
        }) as ExcalidrawElement)
      : element,
  );
};

const getSceneStrokePoints = (
  excalidrawAPI: ExcalidrawImperativeAPI,
  payload: OnyxStrokePayload,
) => {
  const rawPoints = payload.points?.filter(isValidPoint) ?? [];
  if (rawPoints.length < 2) {
    return [];
  }

  const appState = excalidrawAPI.getAppState();
  return simplifyStrokePoints(
    rawPoints.map((point) => {
      const client = nativePointToClientPoint(point, payload);
      const scenePoint = viewportCoordsToSceneCoords(client, appState);
      return {
        x: scenePoint.x,
        y: scenePoint.y,
        p: point.p,
      };
    }),
    appState.zoom.value,
  );
};

const getOnyxStrokeWidth = (strokeWidth: number) => {
  if (strokeWidth <= 1) {
    return THIN_STROKE_WIDTH;
  }
  if (strokeWidth <= 2) {
    return BOLD_STROKE_WIDTH;
  }
  return EXTRA_BOLD_STROKE_WIDTH;
};

const getNativePreviewStrokeWidth = (
  excalidrawStrokeWidth: number,
  zoomValue: number,
) => {
  const effectiveStrokeWidth = getOnyxStrokeWidth(excalidrawStrokeWidth);
  const zoom = Number.isFinite(zoomValue) && zoomValue > 0 ? zoomValue : 1;

  if (effectiveStrokeWidth <= THIN_STROKE_WIDTH) {
    return 5 * zoom;
  }
  if (effectiveStrokeWidth <= BOLD_STROKE_WIDTH) {
    return 8 * NATIVE_PRESSURE_PREVIEW_WIDTH_SCALE * zoom;
  }
  return 12 * NATIVE_PRESSURE_PREVIEW_WIDTH_SCALE * zoom;
};

const nativePointToClientPoint = (
  point: OnyxPoint,
  payload: OnyxStrokePayload,
) => {
  const scaleX =
    payload.surfaceWidth && payload.surfaceWidth > 0
      ? window.innerWidth / payload.surfaceWidth
      : 1;
  const scaleY =
    payload.surfaceHeight && payload.surfaceHeight > 0
      ? window.innerHeight / payload.surfaceHeight
      : 1;

  return {
    clientX: point.x * scaleX,
    clientY: point.y * scaleY,
  };
};

const simplifyStrokePoints = (
  points: SceneStrokePoint[],
  zoomValue: number,
) => {
  const sceneScale = getSceneScaleForZoom(zoomValue);
  const filtered = filterCloseStrokePoints(
    points,
    MIN_STROKE_POINT_DISTANCE * sceneScale,
  );
  if (filtered.length <= 2) {
    return filtered;
  }

  let simplified = filtered;
  let epsilon = STROKE_SIMPLIFICATION_EPSILON * sceneScale;

  for (let pass = 0; pass < MAX_SIMPLIFICATION_PASSES; pass++) {
    simplified = simplifyStrokePointsRdp(filtered, epsilon);
    if (simplified.length <= MAX_POINTS_PER_STROKE) {
      return simplified;
    }
    epsilon *= 1.45;
  }

  return sampleStrokePoints(simplified, MAX_POINTS_PER_STROKE);
};

const filterCloseStrokePoints = (
  points: SceneStrokePoint[],
  minDistance: number,
) => {
  if (points.length <= 2) {
    return points;
  }

  const filtered: SceneStrokePoint[] = [points[0]];
  let lastKeptPoint = points[0];
  const minDistanceSquared = minDistance * minDistance;

  for (let index = 1; index < points.length - 1; index++) {
    const point = points[index];
    const distanceSquared =
      (point.x - lastKeptPoint.x) ** 2 + (point.y - lastKeptPoint.y) ** 2;

    if (distanceSquared >= minDistanceSquared) {
      filtered.push(point);
      lastKeptPoint = point;
    }
  }

  filtered.push(points[points.length - 1]);
  return filtered;
};

const getSceneScaleForZoom = (zoomValue: number) => {
  const zoom = Number.isFinite(zoomValue) && zoomValue > 0 ? zoomValue : 1;
  return 1 / zoom;
};

const simplifyStrokePointsRdp = (
  points: SceneStrokePoint[],
  epsilon: number,
) => {
  const keep = new Array(points.length).fill(false);
  keep[0] = true;
  keep[points.length - 1] = true;

  const stack: Array<[number, number]> = [[0, points.length - 1]];
  const epsilonSquared = epsilon * epsilon;

  while (stack.length) {
    const [startIndex, endIndex] = stack.pop()!;
    let farthestIndex = -1;
    let farthestDistanceSquared = 0;

    for (let index = startIndex + 1; index < endIndex; index++) {
      const distanceSquared = getPointToSegmentDistanceSquared(
        points[index],
        points[startIndex],
        points[endIndex],
      );

      if (distanceSquared > farthestDistanceSquared) {
        farthestDistanceSquared = distanceSquared;
        farthestIndex = index;
      }
    }

    if (farthestDistanceSquared > epsilonSquared && farthestIndex !== -1) {
      keep[farthestIndex] = true;
      stack.push([startIndex, farthestIndex], [farthestIndex, endIndex]);
    }
  }

  return points.filter((_, index) => keep[index]);
};

const getPointToSegmentDistanceSquared = (
  point: SceneStrokePoint,
  start: SceneStrokePoint,
  end: SceneStrokePoint,
) => {
  const deltaX = end.x - start.x;
  const deltaY = end.y - start.y;
  const segmentLengthSquared = deltaX * deltaX + deltaY * deltaY;

  if (!segmentLengthSquared) {
    return (point.x - start.x) ** 2 + (point.y - start.y) ** 2;
  }

  const t = Math.max(
    0,
    Math.min(
      1,
      ((point.x - start.x) * deltaX + (point.y - start.y) * deltaY) /
        segmentLengthSquared,
    ),
  );
  const projectedX = start.x + t * deltaX;
  const projectedY = start.y + t * deltaY;

  return (point.x - projectedX) ** 2 + (point.y - projectedY) ** 2;
};

const sampleStrokePoints = (points: SceneStrokePoint[], maxPoints: number) => {
  if (points.length <= maxPoints) {
    return points;
  }

  const sampled: SceneStrokePoint[] = [];
  const lastIndex = points.length - 1;

  for (let index = 0; index < maxPoints; index++) {
    sampled.push(points[Math.round((index * lastIndex) / (maxPoints - 1))]);
  }

  return sampled;
};

const normalizePressures = (
  points: SceneStrokePoint[],
  strokeWidth: number,
) => {
  if (strokeWidth <= THIN_STROKE_WIDTH) {
    return points.map(() => 0.5);
  }

  const pressures = points.map((point) =>
    Number.isFinite(point.p) && point.p !== undefined ? point.p : 1,
  );
  const maxPressure = Math.max(...pressures);
  const normalized =
    maxPressure > 1
      ? pressures.map((pressure) => pressure / maxPressure)
      : pressures;

  return normalized.map((pressure) => {
    const clampedPressure = Math.max(0, Math.min(1, pressure));
    return (
      MIN_ONYX_PRESSURE +
      clampedPressure * (MAX_ONYX_PRESSURE - MIN_ONYX_PRESSURE)
    );
  });
};

const normalizeStrokeColor = (strokeColor: string) => {
  const lower = strokeColor.toLowerCase();
  return lower === "#000" || lower === "#000000" || lower === "#1e1e1e"
    ? "#000000"
    : strokeColor;
};

const isValidPoint = (point: OnyxPoint) =>
  Number.isFinite(point.x) && Number.isFinite(point.y);

const updateNativeStyle = (excalidrawAPI: ExcalidrawImperativeAPI) => {
  const appState = excalidrawAPI.getAppState();
  const strokeWidth = getNativePreviewStrokeWidth(
    appState.currentItemStrokeWidth,
    appState.zoom.value,
  );
  const pressureSensitive =
    getOnyxStrokeWidth(appState.currentItemStrokeWidth) > THIN_STROKE_WIDTH;
  const signature = [
    Math.round(strokeWidth * 100) / 100,
    normalizeStrokeColor(appState.currentItemStrokeColor),
    100,
    pressureSensitive,
  ].join("|");

  if (signature === lastStyleSignature) {
    return;
  }
  lastStyleSignature = signature;

  OnyxPen.setStyle({
    strokeWidth,
    strokeColor: normalizeStrokeColor(appState.currentItemStrokeColor),
    opacity: 100,
    pressureSensitive,
  }).catch(() => {
    // Native plugin is only available inside the Android shell.
  });
};

const updateNativeExcludedRects = () => {
  const selectors = [
    ".App-toolbar",
    ".mobile-toolbar",
    ".selected-shape-actions-container",
    ".selected-shape-actions",
    ".tool-popover-content",
    ".properties-content",
    ".dropdown-menu-container",
    ".context-menu",
    "[data-radix-popper-content-wrapper]",
    "[role='dialog']",
    "[role='menu']",
    "button",
    "input",
    "textarea",
    "select",
  ].join(",");
  const rects = Array.from(document.querySelectorAll<HTMLElement>(selectors))
    .filter((element) => {
      const style = window.getComputedStyle(element);
      const rect = element.getBoundingClientRect();
      return (
        style.display !== "none" &&
        style.visibility !== "hidden" &&
        style.pointerEvents !== "none" &&
        rect.width > 0 &&
        rect.height > 0 &&
        rect.width * rect.height < window.innerWidth * window.innerHeight * 0.6
      );
    })
    .map((element) => {
      const rect = element.getBoundingClientRect();
      const padding = 10;
      return {
        left: Math.max(0, rect.left - padding),
        top: Math.max(0, rect.top - padding),
        right: Math.min(window.innerWidth, rect.right + padding),
        bottom: Math.min(window.innerHeight, rect.bottom + padding),
      };
    });
  const signature = [
    window.innerWidth,
    window.innerHeight,
    ...rects.map(
      (rect) =>
        `${Math.round(rect.left)},${Math.round(rect.top)},${Math.round(
          rect.right,
        )},${Math.round(rect.bottom)}`,
    ),
  ].join("|");

  if (signature === lastExcludedRectsSignature) {
    return;
  }
  lastExcludedRectsSignature = signature;

  OnyxPen.setExcludedRects({
    rects,
    viewportWidth: window.innerWidth,
    viewportHeight: window.innerHeight,
  }).catch(() => {
    // Native plugin is only available inside the Android shell.
  });
};

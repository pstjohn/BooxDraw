import { newFreeDrawElement } from "@excalidraw/element";

import type { LocalPoint } from "@excalidraw/math";
import type { ExcalidrawElement } from "@excalidraw/element/types";

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

type StrokeConversionAppState = {
  zoomValue: number;
  offsetLeft: number;
  offsetTop: number;
  scrollX: number;
  scrollY: number;
  currentItemStrokeColor: string;
  currentItemBackgroundColor: ExcalidrawElement["backgroundColor"];
  currentItemFillStyle: ExcalidrawElement["fillStyle"];
  currentItemStrokeWidth: number;
  currentItemStrokeStyle: ExcalidrawElement["strokeStyle"];
  currentItemRoughness: number;
};

type StrokeConversionRequest = {
  id: number;
  payloads: OnyxStrokePayload[];
  appState: StrokeConversionAppState;
  viewportWidth: number;
  viewportHeight: number;
};

type StrokeConversionResponse = {
  id: number;
  elements?: ExcalidrawElement[];
  error?: string;
};

const THIN_STROKE_WIDTH = 0.45;
const BOLD_STROKE_WIDTH = 0.8;
const EXTRA_BOLD_STROKE_WIDTH = 1.35;
const MIN_ONYX_PRESSURE = 0.08;
const MAX_ONYX_PRESSURE = 1;
const MIN_STROKE_POINT_DISTANCE = 0.16;
const STROKE_SIMPLIFICATION_EPSILON = 0.16;
const ONYX_FREEDRAW_SMOOTHING = 0.28;
const ONYX_FREEDRAW_STREAMLINE = 0.12;
const MAX_POINTS_PER_STROKE = 800;
const MAX_SIMPLIFICATION_PASSES = 4;

self.onmessage = (event: MessageEvent<StrokeConversionRequest>) => {
  const { id, payloads, appState, viewportWidth, viewportHeight } = event.data;

  try {
    const elements: ExcalidrawElement[] = [];

    for (const payload of payloads) {
      const element = createStrokeElement(
        payload,
        appState,
        viewportWidth,
        viewportHeight,
      );
      if (element) {
        elements.push(element);
      }
    }

    const response: StrokeConversionResponse = { id, elements };
    self.postMessage(response);
  } catch (error) {
    const response: StrokeConversionResponse = {
      id,
      error: error instanceof Error ? error.message : String(error),
    };
    self.postMessage(response);
  }
};

const createStrokeElement = (
  payload: OnyxStrokePayload,
  appState: StrokeConversionAppState,
  viewportWidth: number,
  viewportHeight: number,
): ExcalidrawElement | null => {
  const rawPoints = payload.points?.filter(isValidPoint) ?? [];
  if (rawPoints.length < 2) {
    return null;
  }

  const scenePoints = simplifyStrokePoints(
    rawPoints.map((point) => {
      const client = nativePointToClientPoint(
        point,
        payload,
        viewportWidth,
        viewportHeight,
      );
      const scenePoint = viewportCoordsToSceneCoords(client, appState);
      return {
        x: scenePoint.x,
        y: scenePoint.y,
        p: point.p,
      };
    }),
    appState.zoomValue,
  );

  if (scenePoints.length < 2) {
    return null;
  }

  const originX = scenePoints[0].x;
  const originY = scenePoints[0].y;
  if (!Number.isFinite(originX) || !Number.isFinite(originY)) {
    return null;
  }

  const localPoints = scenePoints.map(
    (point) => [point.x - originX, point.y - originY] as LocalPoint,
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

  return newFreeDrawElement({
    type: "freedraw",
    x: originX,
    y: originY,
    width: maxX - minX,
    height: maxY - minY,
    strokeColor: normalizeStrokeColor(appState.currentItemStrokeColor),
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

const viewportCoordsToSceneCoords = (
  { clientX, clientY }: { clientX: number; clientY: number },
  appState: StrokeConversionAppState,
) => {
  return {
    x: (clientX - appState.offsetLeft) / appState.zoomValue - appState.scrollX,
    y: (clientY - appState.offsetTop) / appState.zoomValue - appState.scrollY,
  };
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

const nativePointToClientPoint = (
  point: OnyxPoint,
  payload: OnyxStrokePayload,
  viewportWidth: number,
  viewportHeight: number,
) => {
  const scaleX =
    payload.surfaceWidth && payload.surfaceWidth > 0
      ? viewportWidth / payload.surfaceWidth
      : 1;
  const scaleY =
    payload.surfaceHeight && payload.surfaceHeight > 0
      ? viewportHeight / payload.surfaceHeight
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

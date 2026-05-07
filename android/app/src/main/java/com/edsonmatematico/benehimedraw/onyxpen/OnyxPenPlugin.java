package com.edsonmatematico.benehimedraw.onyxpen;

import android.app.Activity;
import android.graphics.Color;
import android.graphics.Rect;
import android.util.Log;
import android.view.View;
import android.webkit.WebView;

import androidx.annotation.Nullable;

import com.edsonmatematico.benehimedraw.R;
import com.getcapacitor.JSArray;
import com.getcapacitor.JSObject;
import com.getcapacitor.Plugin;
import com.getcapacitor.PluginCall;
import com.getcapacitor.PluginMethod;
import com.getcapacitor.annotation.CapacitorPlugin;
import com.onyx.android.sdk.api.device.epd.EpdController;
import com.onyx.android.sdk.api.device.epd.UpdateMode;

import org.json.JSONObject;

import java.lang.ref.WeakReference;
import java.util.List;

@CapacitorPlugin(name = "OnyxPen")
public class OnyxPenPlugin extends Plugin {
    private static WeakReference<OnyxPenPlugin> activePlugin = new WeakReference<>(null);

    @Nullable private PenSurfaceView penSurface;
    private boolean enabled = true;

    public static void bindSurface(PenSurfaceView surface) {
        OnyxPenPlugin plugin = activePlugin.get();
        if (plugin != null) {
            plugin.attachSurface(surface);
        }
    }

    @Override
    public void load() {
        activePlugin = new WeakReference<>(this);
        attachSurface(findSurface());
    }

    @PluginMethod
    public void enable(PluginCall call) {
        enabled = true;
        attachSurface(findSurface());
        if (penSurface != null) {
            penSurface.setRawDrawingEnabled(true);
        }
        Log.i(OnyxInputBridge.TAG, "OnyxPenPlugin enable surface=" + (penSurface != null));
        call.resolve();
    }

    @PluginMethod
    public void disable(PluginCall call) {
        enabled = false;
        if (penSurface != null) {
            penSurface.setRawDrawingEnabled(false);
        }
        call.resolve();
    }

    @PluginMethod
    public void clear(PluginCall call) {
        PenSurfaceView surface = penSurface;
        Rect dirtyRect = parseDirtyRect(call);
        Integer expectedGeneration = parseExpectedGeneration(call);
        Activity activity = getActivity();
        if (surface != null && activity != null) {
            activity.runOnUiThread(() -> {
                boolean didRun = surface.clearInkIfSafe(dirtyRect, expectedGeneration);
                call.resolve(createHandoffResult(didRun));
            });
        } else if (surface != null) {
            boolean didRun = surface.clearInkIfSafe(dirtyRect, expectedGeneration);
            call.resolve(createHandoffResult(didRun));
        } else {
            call.resolve(createHandoffResult(false));
        }
    }

    @PluginMethod
    public void refreshWebViewRegion(PluginCall call) {
        Rect dirtyRect = parseDirtyRect(call);
        Activity activity = getActivity();
        if (activity == null) {
            call.resolve();
            return;
        }

        activity.runOnUiThread(() -> {
            WebView webView = findWebView();
            Rect refreshRect = normalizeDirtyRect(webView, dirtyRect);
            if (webView != null && refreshRect != null) {
                try {
                    UpdateMode updateMode = EpdController.supportRegal()
                            ? UpdateMode.REGAL_D
                            : UpdateMode.GU;
                    Log.i(OnyxInputBridge.TAG, "refreshWebViewRegion rect=" + refreshRect
                            + " mode=" + updateMode);
                    EpdController.invalidate(
                            webView,
                            refreshRect.left,
                            refreshRect.top,
                            refreshRect.width(),
                            refreshRect.height(),
                            updateMode);
                    EpdController.refreshScreenRegion(
                            webView,
                            refreshRect.left,
                            refreshRect.top,
                            refreshRect.width(),
                            refreshRect.height(),
                            updateMode);
                } catch (Throwable t) {
                    Log.w(OnyxInputBridge.TAG, "refreshWebViewRegion failed", t);
                }
            }
            call.resolve();
        });
    }

    @PluginMethod
    public void refreshWebViewQuality(PluginCall call) {
        Rect dirtyRect = parseDirtyRect(call);
        Activity activity = getActivity();
        if (activity == null) {
            call.resolve();
            return;
        }

        activity.runOnUiThread(() -> {
            WebView webView = findWebView();
            View rootView = findContentView();
            if (webView != null) {
                try {
                    Rect rootRect = toRootRect(rootView, webView, dirtyRect);
                    if (rootView != null && rootRect != null) {
                        Log.i(OnyxInputBridge.TAG, "refreshWebViewQuality rootRect="
                                + rootRect + " mode=DU_QUALITY");
                        EpdController.invalidate(
                                rootView,
                                rootRect.left,
                                rootRect.top,
                                rootRect.width(),
                                rootRect.height(),
                                UpdateMode.DU_QUALITY);
                        EpdController.refreshScreenRegion(
                                rootView,
                                rootRect.left,
                                rootRect.top,
                                rootRect.width(),
                                rootRect.height(),
                                UpdateMode.DU_QUALITY);
                    } else {
                        Log.i(OnyxInputBridge.TAG, "refreshWebViewQuality mode=GC");
                        EpdController.refreshScreen(webView, UpdateMode.GC);
                    }
                } catch (Throwable t) {
                    Log.w(OnyxInputBridge.TAG, "refreshWebViewQuality failed", t);
                }
            }
            call.resolve();
        });
    }

    @PluginMethod
    public void repaintWebViewHandwriting(PluginCall call) {
        Rect dirtyRect = parseDirtyRect(call);
        Integer expectedGeneration = parseExpectedGeneration(call);
        Activity activity = getActivity();
        if (activity == null) {
            call.resolve(createHandoffResult(false));
            return;
        }

        activity.runOnUiThread(() -> {
            PenSurfaceView surface = penSurface;
            if (surface != null && !surface.canApplyNativeHandoff(expectedGeneration)) {
                Log.i(OnyxInputBridge.TAG, "repaintWebViewHandwriting skipped expectedGeneration="
                        + expectedGeneration
                        + " currentGeneration=" + surface.getStrokeGeneration());
                call.resolve(createHandoffResult(false));
                return;
            }
            WebView webView = findWebView();
            Rect refreshRect = normalizeDirtyRect(webView, dirtyRect);
            boolean didRun = false;
            if (webView != null && refreshRect != null) {
                try {
                    Log.i(OnyxInputBridge.TAG, "repaintWebViewHandwriting rect=" + refreshRect);
                    webView.invalidate(refreshRect);
                    EpdController.handwritingRepaint(webView, refreshRect);
                    didRun = true;
                } catch (Throwable t) {
                    Log.w(OnyxInputBridge.TAG, "repaintWebViewHandwriting failed", t);
                }
            }
            call.resolve(createHandoffResult(didRun));
        });
    }

    @Nullable
    private static Rect normalizeDirtyRect(@Nullable View view, @Nullable Rect dirtyRect) {
        if (view == null || dirtyRect == null) {
            return null;
        }
        int w = view.getWidth();
        int h = view.getHeight();
        if (w <= 0 || h <= 0) {
            return null;
        }
        Rect normalized = new Rect(dirtyRect);
        normalized.intersect(0, 0, w, h);
        return normalized.isEmpty() ? null : normalized;
    }

    @Nullable
    private static Rect toRootRect(
            @Nullable View rootView,
            @Nullable WebView webView,
            @Nullable Rect dirtyRect) {
        if (rootView == null || webView == null || dirtyRect == null) {
            return null;
        }

        Rect webRect = normalizeDirtyRect(webView, dirtyRect);
        if (webRect == null) {
            return null;
        }

        int[] rootLocation = new int[2];
        int[] webViewLocation = new int[2];
        rootView.getLocationOnScreen(rootLocation);
        webView.getLocationOnScreen(webViewLocation);

        Rect rootRect = new Rect(webRect);
        rootRect.offset(
                webViewLocation[0] - rootLocation[0],
                webViewLocation[1] - rootLocation[1]);
        rootRect.intersect(0, 0, rootView.getWidth(), rootView.getHeight());
        return rootRect.isEmpty() ? null : rootRect;
    }

    @Nullable
    private Rect parseDirtyRect(PluginCall call) {
        if (!call.getData().has("left")
                || !call.getData().has("top")
                || !call.getData().has("right")
                || !call.getData().has("bottom")) {
            return null;
        }

        int left = (int) Math.floor(call.getDouble("left", 0.0));
        int top = (int) Math.floor(call.getDouble("top", 0.0));
        int right = (int) Math.ceil(call.getDouble("right", 0.0));
        int bottom = (int) Math.ceil(call.getDouble("bottom", 0.0));
        return right > left && bottom > top ? new Rect(left, top, right, bottom) : null;
    }

    @Nullable
    private Integer parseExpectedGeneration(PluginCall call) {
        return call.getData().has("expectedGeneration")
                ? call.getData().optInt("expectedGeneration")
                : null;
    }

    private static JSObject createHandoffResult(boolean didRun) {
        JSObject result = new JSObject();
        result.put("didRun", didRun);
        return result;
    }

    @PluginMethod
    public void setStyle(PluginCall call) {
        PenSurfaceView surface = penSurface;
        if (surface == null) {
            call.resolve();
            return;
        }

        double width = call.getDouble("strokeWidth", 5.0);
        String strokeColor = call.getString("strokeColor", "#000000");
        double opacity = call.getDouble("opacity", 100.0);
        boolean pressureSensitive = Boolean.TRUE.equals(call.getBoolean("pressureSensitive", false));
        int color = parseColor(strokeColor, opacity);

        Activity activity = getActivity();
        if (activity != null) {
            activity.runOnUiThread(() ->
                    surface.setPreviewStyle((float) width, color, pressureSensitive));
        } else {
            surface.setPreviewStyle((float) width, color, pressureSensitive);
        }
        call.resolve();
    }

    private void attachSurface(@Nullable PenSurfaceView surface) {
        if (surface == null || surface == penSurface) return;
        penSurface = surface;
        penSurface.setStrokeListener(new OnyxInputBridge.StrokeListener() {
            @Override
            public void onDrawingStroke(List<OnyxInputBridge.StrokePoint> points) {
                emitStroke("pen", points);
            }

            @Override
            public void onErasingStroke(List<OnyxInputBridge.StrokePoint> points) {
                emitStroke("eraser", points);
            }

            @Override
            public void onStylusPointerDown() {
                emitPointerDown();
            }
        });
        Log.i(OnyxInputBridge.TAG, "OnyxPenPlugin attached surface");
    }

    private static int parseColor(@Nullable String strokeColor, double opacity) {
        int color = Color.BLACK;
        if (strokeColor != null && !"transparent".equalsIgnoreCase(strokeColor)) {
            try {
                color = Color.parseColor(strokeColor);
            } catch (IllegalArgumentException ignored) {
                color = Color.BLACK;
            }
        }

        int alpha = (int) Math.round(Math.max(0.0, Math.min(100.0, opacity)) * 2.55);
        return Color.argb(alpha, Color.red(color), Color.green(color), Color.blue(color));
    }

    @PluginMethod
    public void setExcludedRects(PluginCall call) {
        PenSurfaceView surface = penSurface;
        if (surface == null) {
            call.resolve();
            return;
        }

        JSArray jsRects = call.getArray("rects", new JSArray());
        double viewportWidth = call.getDouble("viewportWidth", 0.0);
        double viewportHeight = call.getDouble("viewportHeight", 0.0);
        int surfaceWidth = surface.getWidth();
        int surfaceHeight = surface.getHeight();
        double scaleX = viewportWidth > 0 && surfaceWidth > 0 ? surfaceWidth / viewportWidth : 1.0;
        double scaleY = viewportHeight > 0 && surfaceHeight > 0 ? surfaceHeight / viewportHeight : 1.0;
        List<Rect> rects = new java.util.ArrayList<>();

        for (int i = 0; i < jsRects.length(); i++) {
            JSONObject jsRect = jsRects.optJSONObject(i);
            if (jsRect == null) continue;
            int left = (int) Math.floor(jsRect.optDouble("left", 0.0) * scaleX);
            int top = (int) Math.floor(jsRect.optDouble("top", 0.0) * scaleY);
            int right = (int) Math.ceil(jsRect.optDouble("right", 0.0) * scaleX);
            int bottom = (int) Math.ceil(jsRect.optDouble("bottom", 0.0) * scaleY);
            if (right > left && bottom > top) {
                rects.add(new Rect(left, top, right, bottom));
            }
        }

        Activity activity = getActivity();
        if (activity != null) {
            activity.runOnUiThread(() -> surface.setExcludedRects(rects));
        } else {
            surface.setExcludedRects(rects);
        }
        call.resolve();
    }

    @Nullable
    private PenSurfaceView findSurface() {
        Activity activity = getActivity();
        if (activity == null) return null;
        return activity.findViewById(R.id.pen_surface_id);
    }

    @Nullable
    private WebView findWebView() {
        Activity activity = getActivity();
        if (activity == null) return null;
        return activity.findViewById(com.getcapacitor.android.R.id.webview);
    }

    @Nullable
    private View findContentView() {
        Activity activity = getActivity();
        if (activity == null) return null;
        return activity.findViewById(android.R.id.content);
    }

    private void emitStroke(String tool, List<OnyxInputBridge.StrokePoint> points) {
        if (!enabled || points == null) return;
        if (points == null || points.isEmpty()) return;
        PenSurfaceView surface = penSurface;
        Log.i(OnyxInputBridge.TAG, "emitStroke tool=" + tool
                + " points=" + points.size()
                + " surface=" + (surface == null ? 0 : surface.getWidth())
                + "x" + (surface == null ? 0 : surface.getHeight()));

        JSObject payload = new JSObject();
        JSArray jsPoints = new JSArray();
        for (OnyxInputBridge.StrokePoint point : points) {
            if (point == null) continue;
            JSObject jsPoint = new JSObject();
            jsPoint.put("x", point.x);
            jsPoint.put("y", point.y);
            jsPoint.put("p", point.pressure);
            jsPoints.put(jsPoint);
        }

        payload.put("tool", tool);
        payload.put("points", jsPoints);
        payload.put("surfaceWidth", surface == null ? 0 : surface.getWidth());
        payload.put("surfaceHeight", surface == null ? 0 : surface.getHeight());
        payload.put("generation", surface == null ? 0 : surface.getStrokeGeneration());

        Activity activity = getActivity();
        if (activity != null) {
            activity.runOnUiThread(() -> notifyListeners("onyxStroke", payload, true));
        } else {
            notifyListeners("onyxStroke", payload, true);
        }
    }

    private void emitPointerDown() {
        PenSurfaceView surface = penSurface;
        JSObject payload = new JSObject();
        payload.put("generation", surface == null ? 0 : surface.getStrokeGeneration());
        Activity activity = getActivity();
        if (activity != null) {
            activity.runOnUiThread(() -> notifyListeners("onyxPointerDown", payload, true));
        } else {
            notifyListeners("onyxPointerDown", payload, true);
        }
    }
}

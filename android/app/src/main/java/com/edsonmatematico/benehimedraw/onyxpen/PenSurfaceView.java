package com.edsonmatematico.benehimedraw.onyxpen;

import android.content.Context;
import android.graphics.Canvas;
import android.graphics.Color;
import android.graphics.PorterDuff;
import android.graphics.Rect;
import android.os.SystemClock;
import android.util.AttributeSet;
import android.util.Log;
import android.view.MotionEvent;
import android.view.SurfaceHolder;
import android.view.SurfaceView;

import androidx.annotation.Nullable;

import com.onyx.android.sdk.pen.RawInputCallback;
import com.onyx.android.sdk.pen.TouchHelper;
import com.onyx.android.sdk.pen.style.StrokeStyle;
import com.onyx.android.sdk.api.device.epd.EpdController;
import com.onyx.android.sdk.api.device.epd.UpdateMode;

import java.util.ArrayList;
import java.util.Collections;
import java.util.List;

public class PenSurfaceView extends SurfaceView implements SurfaceHolder.Callback {

    @Nullable private TouchHelper touchHelper;
    private final OnyxInputBridge inputCallback = new OnyxInputBridge();
    private final List<OnyxInputBridge.StrokePoint> motionStrokePoints = new ArrayList<>();
    private final List<Rect> excludedRects = new ArrayList<>();
    private float previewStrokeWidth = 5.0f;
    private int previewStrokeColor = Color.BLACK;
    private int previewStrokeStyle = StrokeStyle.PENCIL;
    private long motionStrokeStartedAt;
    private boolean routingStylusToWebView;
    private int clearInkGeneration;
    private boolean rawDrawingRenderSuspended;
    private int strokeGeneration;
    private boolean stylusActive;

    public PenSurfaceView(Context context) {
        super(context);
        init();
    }

    public PenSurfaceView(Context context, @Nullable AttributeSet attrs) {
        super(context, attrs);
        init();
    }

    public PenSurfaceView(Context context, @Nullable AttributeSet attrs, int defStyleAttr) {
        super(context, attrs, defStyleAttr);
        init();
    }

    private void init() {
        // Bottom-of-hierarchy SurfaceView. The WebView will be set transparent
        // so the SurfaceView (and Onyx ink) are visible underneath it.
        getHolder().addCallback(this);
    }

    @Override
    public void surfaceCreated(SurfaceHolder holder) {
        Log.i(OnyxInputBridge.TAG, "surfaceCreated view=" + getWidth() + "x" + getHeight()
                + " onyx=" + DeviceCompat.isOnyxDevice());
        if (!DeviceCompat.isOnyxDevice()) return;
        try {
            touchHelper = TouchHelper.create(this, inputCallback);
            applyStrokeStyle();
            touchHelper.openRawDrawing();
            applyLimitRect();
            touchHelper.setRawDrawingEnabled(true);
            Log.i(OnyxInputBridge.TAG, "TouchHelper enabled");
        } catch (Throwable t) {
            Log.w(OnyxInputBridge.TAG, "TouchHelper setup failed", t);
        }
    }

    @Override
    public void surfaceChanged(SurfaceHolder holder, int format, int width, int height) {
        Log.i(OnyxInputBridge.TAG, "surfaceChanged " + width + "x" + height);
        if (touchHelper == null) return;
        try {
            touchHelper.setRawDrawingEnabled(false);
        } catch (Throwable ignored) {}
        applyLimitRect();
        try {
            touchHelper.setRawDrawingEnabled(true);
        } catch (Throwable ignored) {}
    }

    @Override
    public void surfaceDestroyed(SurfaceHolder holder) {
        if (touchHelper == null) return;
        try {
            touchHelper.setRawDrawingEnabled(false);
            touchHelper.closeRawDrawing();
        } catch (Throwable t) {
            Log.w(OnyxInputBridge.TAG, "TouchHelper teardown failed", t);
        } finally {
            touchHelper = null;
        }
    }

    public void setStrokeListener(@Nullable OnyxInputBridge.StrokeListener listener) {
        inputCallback.setStrokeListener(listener);
    }

    public void setRawDrawingEnabled(boolean enabled) {
        if (touchHelper == null) return;
        try {
            touchHelper.setRawDrawingEnabled(enabled);
        } catch (Throwable t) {
            Log.w(OnyxInputBridge.TAG, "setRawDrawingEnabled failed enabled=" + enabled, t);
        }
    }

    public void setExcludedRects(List<Rect> rects) {
        excludedRects.clear();
        if (rects != null) {
            excludedRects.addAll(rects);
        }
        applyLimitRect();
    }

    public void setPreviewStyle(float strokeWidth, int strokeColor, boolean pressureSensitive) {
        previewStrokeWidth = Math.max(1.0f, strokeWidth);
        previewStrokeColor = strokeColor;
        previewStrokeStyle = pressureSensitive ? StrokeStyle.FOUNTAIN : StrokeStyle.PENCIL;
        applyStrokeStyle();
    }

    private void applyStrokeStyle() {
        if (touchHelper == null) return;
        try {
            touchHelper.setStrokeStyle(previewStrokeStyle)
                    .setStrokeWidth(previewStrokeWidth)
                    .setStrokeColor(previewStrokeColor);
            Log.i(OnyxInputBridge.TAG, "applyStrokeStyle width=" + previewStrokeWidth
                    + " color=" + previewStrokeColor
                    + " pressure=" + (previewStrokeStyle == StrokeStyle.FOUNTAIN));
        } catch (Throwable t) {
            Log.w(OnyxInputBridge.TAG, "applyStrokeStyle failed", t);
        }
    }

    public void clearInk(@Nullable Rect dirtyRect) {
        int generation = ++clearInkGeneration;
        Rect refreshRect = normalizeDirtyRect(dirtyRect);
        Log.d(OnyxInputBridge.TAG, "clearInk rect=" + refreshRect);
        setRawDrawingRenderEnabledForClear(false);

        clearSurface(getHolder(), refreshRect);
        refreshInkRegion(refreshRect);
        if (refreshRect != null) {
            Rect delayedRefreshRect = new Rect(refreshRect);
            postDelayed(() -> {
                if (generation != clearInkGeneration) {
                    Log.d(OnyxInputBridge.TAG, "clearInk delayed skipped stale generation");
                    return;
                }
                Log.d(OnyxInputBridge.TAG, "clearInk delayed rect=" + delayedRefreshRect);
                clearSurface(getHolder(), delayedRefreshRect);
                refreshInkRegion(delayedRefreshRect);
            }, 90);
        }

        postDelayed(() -> {
            if (generation != clearInkGeneration) {
                Log.d(OnyxInputBridge.TAG, "raw drawing render re-enable skipped stale generation");
                return;
            }
            setRawDrawingRenderEnabledForClear(true);
        }, 300);
    }

    public boolean clearInkIfSafe(@Nullable Rect dirtyRect, @Nullable Integer expectedStrokeGeneration) {
        if (!canApplyNativeHandoff(expectedStrokeGeneration)) {
            Log.i(OnyxInputBridge.TAG, "clearInk skipped expectedGeneration="
                    + expectedStrokeGeneration
                    + " currentGeneration=" + strokeGeneration
                    + " stylusActive=" + stylusActive);
            return false;
        }
        clearInk(dirtyRect);
        return true;
    }

    public boolean canApplyNativeHandoff(@Nullable Integer expectedStrokeGeneration) {
        return expectedStrokeGeneration == null
                || (expectedStrokeGeneration == strokeGeneration && !stylusActive);
    }

    public int getStrokeGeneration() {
        return strokeGeneration;
    }

    private void setRawDrawingRenderEnabledForClear(boolean enabled) {
        TouchHelper helper = touchHelper;
        if (helper == null) return;
        try {
            helper.setRawDrawingRenderEnabled(enabled);
            rawDrawingRenderSuspended = !enabled;
            Log.d(OnyxInputBridge.TAG, "raw drawing render enabled=" + enabled);
        } catch (Throwable t) {
            Log.w(OnyxInputBridge.TAG, "setRawDrawingRenderEnabled(" + enabled + ") failed", t);
        }
    }

    private void resumeRawDrawingRenderForNewStroke() {
        if (!rawDrawingRenderSuspended) return;
        ++clearInkGeneration;
        setRawDrawingRenderEnabledForClear(true);
    }

    private void clearSurface(SurfaceHolder holder, Rect dirtyRect) {
        try {
            Rect canvasRect = dirtyRect == null ? null : new Rect(dirtyRect);
            Canvas c = canvasRect == null ? holder.lockCanvas() : holder.lockCanvas(canvasRect);
            if (c != null) {
                c.drawColor(Color.TRANSPARENT, PorterDuff.Mode.CLEAR);
                holder.unlockCanvasAndPost(c);
            }
        } catch (Throwable t) {
            Log.w(OnyxInputBridge.TAG, "clearSurface failed", t);
        }
    }

    private void refreshInkRegion(@Nullable Rect dirtyRect) {
        int w = getWidth();
        int h = getHeight();
        if (w <= 0 || h <= 0) return;
        Rect rect = dirtyRect == null ? new Rect(0, 0, w, h) : dirtyRect;
        try {
            EpdController.refreshScreenRegion(
                    this,
                    rect.left,
                    rect.top,
                    rect.width(),
                    rect.height(),
                    UpdateMode.DU_QUALITY);
        } catch (Throwable t) {
            Log.w(OnyxInputBridge.TAG, "refreshInkRegion failed", t);
        }
    }

    @Nullable
    private Rect normalizeDirtyRect(@Nullable Rect dirtyRect) {
        int w = getWidth();
        int h = getHeight();
        if (w <= 0 || h <= 0 || dirtyRect == null) {
            return null;
        }
        Rect normalized = new Rect(dirtyRect);
        normalized.intersect(0, 0, w, h);
        return normalized.isEmpty() ? null : normalized;
    }

    private void applyLimitRect() {
        if (touchHelper == null) return;
        int w = getWidth();
        int h = getHeight();
        if (w <= 0 || h <= 0) {
            Log.w(OnyxInputBridge.TAG, "applyLimitRect skipped: zero dimensions");
            return;
        }
        Rect full = new Rect(0, 0, w, h);
        Log.i(OnyxInputBridge.TAG, "applyLimitRect " + full);
        touchHelper.setLimitRect(Collections.singletonList(full))
                .setExcludeRect(new ArrayList<>(excludedRects));
    }

    @Override
    public boolean dispatchTouchEvent(MotionEvent ev) {
        if (ev == null) return false;
        boolean stylus = hasStylusPointer(ev);
        if (!stylus) return false;

        int action = ev.getActionMasked();
        if (action == MotionEvent.ACTION_DOWN) {
            routingStylusToWebView = isInExcludedRect(ev);
        }
        if (routingStylusToWebView) {
            if (action == MotionEvent.ACTION_UP || action == MotionEvent.ACTION_CANCEL) {
                routingStylusToWebView = false;
            }
            return false;
        }

        if (action == MotionEvent.ACTION_DOWN) {
            motionStrokePoints.clear();
            motionStrokeStartedAt = SystemClock.uptimeMillis();
            strokeGeneration++;
            stylusActive = true;
            resumeRawDrawingRenderForNewStroke();
            Log.i(OnyxInputBridge.TAG, "dispatchTouchEvent DOWN stylus=true"
                    + " tool=" + ev.getToolType(0)
                    + " generation=" + strokeGeneration);
            inputCallback.onStylusPointerDown();
            addMotionPoints(ev);
        } else if (action == MotionEvent.ACTION_MOVE) {
            addMotionPoints(ev);
        } else if (action == MotionEvent.ACTION_UP || action == MotionEvent.ACTION_CANCEL) {
            addMotionPoints(ev);
            List<OnyxInputBridge.StrokePoint> points = new ArrayList<>(motionStrokePoints);
            long startedAt = motionStrokeStartedAt;
            motionStrokePoints.clear();
            stylusActive = false;
            postDelayed(() -> {
                if (inputCallback.hasRawStrokeSince(startedAt)) {
                    Log.i(OnyxInputBridge.TAG, "motion fallback skipped raw stroke already received");
                    return;
                }
                inputCallback.onMotionStrokeReceived(points);
            }, 200);
        }
        return true;
    }

    private static boolean hasStylusPointer(MotionEvent ev) {
        for (int i = 0; i < ev.getPointerCount(); i++) {
            int t = ev.getToolType(i);
            if (t == MotionEvent.TOOL_TYPE_STYLUS || t == MotionEvent.TOOL_TYPE_ERASER) {
                return true;
            }
        }
        return false;
    }

    private void addMotionPoints(MotionEvent ev) {
        int pointerIndex = findStylusPointerIndex(ev);
        if (pointerIndex < 0) return;
        int historySize = ev.getHistorySize();
        for (int h = 0; h < historySize; h++) {
            motionStrokePoints.add(new OnyxInputBridge.StrokePoint(
                    ev.getHistoricalX(pointerIndex, h),
                    ev.getHistoricalY(pointerIndex, h),
                    ev.getHistoricalPressure(pointerIndex, h)));
        }
        motionStrokePoints.add(new OnyxInputBridge.StrokePoint(
                ev.getX(pointerIndex),
                ev.getY(pointerIndex),
                ev.getPressure(pointerIndex)));
    }

    private static int findStylusPointerIndex(MotionEvent ev) {
        for (int i = 0; i < ev.getPointerCount(); i++) {
            int t = ev.getToolType(i);
            if (t == MotionEvent.TOOL_TYPE_STYLUS || t == MotionEvent.TOOL_TYPE_ERASER) {
                return i;
            }
        }
        return -1;
    }

    private boolean isInExcludedRect(MotionEvent ev) {
        int pointerIndex = findStylusPointerIndex(ev);
        if (pointerIndex < 0) return false;
        int x = Math.round(ev.getX(pointerIndex));
        int y = Math.round(ev.getY(pointerIndex));
        for (Rect rect : excludedRects) {
            if (rect.contains(x, y)) {
                return true;
            }
        }
        return false;
    }
}

package com.edsonmatematico.benehimedraw.onyxpen;

import android.graphics.RectF;
import android.os.SystemClock;
import android.util.Log;

import com.onyx.android.sdk.data.note.TouchPoint;
import com.onyx.android.sdk.pen.RawInputCallback;
import com.onyx.android.sdk.pen.data.TouchPointList;

import java.util.ArrayList;
import java.util.List;

class OnyxInputBridge extends RawInputCallback {
    static final String TAG = "OnyxPen";

    static class StrokePoint {
        final float x;
        final float y;
        final float pressure;

        StrokePoint(float x, float y, float pressure) {
            this.x = x;
            this.y = y;
            this.pressure = pressure;
        }
    }

    interface StrokeListener {
        void onDrawingStroke(List<StrokePoint> points);
        void onErasingStroke(List<StrokePoint> points);
        void onStylusPointerDown();
    }

    private StrokeListener strokeListener;
    private long lastRawStrokeAt;

    void setStrokeListener(StrokeListener strokeListener) {
        this.strokeListener = strokeListener;
    }

    @Override
    public void onBeginRawDrawing(boolean shortcutDrawing, TouchPoint touchPoint) {}

    @Override
    public void onEndRawDrawing(boolean outOfRegion, TouchPoint touchPoint) {}

    @Override
    public void onRawDrawingTouchPointMoveReceived(TouchPoint touchPoint) {}

    @Override
    public void onRawDrawingTouchPointListReceived(TouchPointList plist) {
        List<StrokePoint> points = convertPoints(plist);
        int n = points.size();
        Log.d(TAG, "stroke n=" + n);
        lastRawStrokeAt = SystemClock.uptimeMillis();
        if (!points.isEmpty() && strokeListener != null) {
            strokeListener.onDrawingStroke(points);
        }
    }

    @Override
    public void onBeginRawErasing(boolean shortcutErasing, TouchPoint touchPoint) {}

    @Override
    public void onEndRawErasing(boolean outOfRegion, TouchPoint touchPoint) {}

    @Override
    public void onRawErasingTouchPointMoveReceived(TouchPoint touchPoint) {}

    @Override
    public void onRawErasingTouchPointListReceived(TouchPointList plist) {
        List<StrokePoint> points = convertPoints(plist);
        int n = points.size();
        Log.d(TAG, "erase n=" + n);
        lastRawStrokeAt = SystemClock.uptimeMillis();
        if (!points.isEmpty() && strokeListener != null) {
            strokeListener.onErasingStroke(points);
        }
    }

    boolean hasRawStrokeSince(long sinceUptimeMs) {
        return lastRawStrokeAt >= sinceUptimeMs;
    }

    void onMotionStrokeReceived(List<StrokePoint> points) {
        int n = points == null ? 0 : points.size();
        Log.i(TAG, "motion fallback stroke n=" + n);
        if (points != null && !points.isEmpty() && strokeListener != null) {
            strokeListener.onDrawingStroke(points);
        }
    }

    void onStylusPointerDown() {
        if (strokeListener != null) {
            strokeListener.onStylusPointerDown();
        }
    }

    private static List<StrokePoint> convertPoints(TouchPointList plist) {
        List<TouchPoint> rawPoints = plist == null ? null : plist.getPoints();
        List<StrokePoint> points = new ArrayList<>();
        if (rawPoints == null) return points;
        for (TouchPoint point : rawPoints) {
            if (point == null) continue;
            points.add(new StrokePoint(point.x, point.y, point.pressure));
        }
        return points;
    }

    @Override
    public void onPenUpRefresh(RectF refreshRect) {
        super.onPenUpRefresh(refreshRect);
    }

    @Override
    public void onPenActive(TouchPoint point) {
        super.onPenActive(point);
    }
}

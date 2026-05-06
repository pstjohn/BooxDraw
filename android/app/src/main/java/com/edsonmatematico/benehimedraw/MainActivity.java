package com.edsonmatematico.benehimedraw;

import android.graphics.Color;
import android.os.Bundle;
import android.view.MotionEvent;
import android.view.View;
import android.view.ViewGroup;
import android.webkit.WebView;
import android.widget.FrameLayout;

import com.edsonmatematico.benehimedraw.onyxpen.OnyxPenPlugin;
import com.edsonmatematico.benehimedraw.onyxpen.PenSurfaceView;
import com.getcapacitor.BridgeActivity;
import com.onyx.android.sdk.api.device.epd.EpdController;

public class MainActivity extends BridgeActivity {

    private PenSurfaceView penSurface;

    @Override
    protected void onCreate(Bundle savedInstanceState) {
        registerPlugin(OnyxPenPlugin.class);
        super.onCreate(savedInstanceState);

        ViewGroup content = findViewById(android.R.id.content);
        if (content == null || content.getChildCount() == 0) return;

        WebView webView = findViewById(com.getcapacitor.android.R.id.webview);
        if (webView != null) {
            webView.setBackgroundColor(Color.TRANSPARENT);
            try {
                EpdController.setWebViewContrastOptimize(webView, true);
            } catch (Throwable ignored) {}
        }

        penSurface = new PenSurfaceView(this);
        penSurface.setId(R.id.pen_surface_id);
        FrameLayout.LayoutParams lp = new FrameLayout.LayoutParams(
                ViewGroup.LayoutParams.MATCH_PARENT,
                ViewGroup.LayoutParams.MATCH_PARENT);
        // Insert at index 0: bottom of hierarchy. WebView (transparent) renders on top.
        content.addView(penSurface, 0, lp);
        OnyxPenPlugin.bindSurface(penSurface);
    }

    @Override
    public boolean dispatchTouchEvent(MotionEvent ev) {
        // Route stylus events directly to PenSurfaceView, bypassing the WebView.
        // Finger events fall through normal dispatch (WebView to Excalidraw).
        // Stylus taps over UI are also passed to WebView so toolbar/popover
        // controls remain usable with the pen.
        if (ev != null && penSurface != null && hasStylusPointer(ev)) {
            if (penSurface.dispatchTouchEvent(ev)) {
                return true;
            }
        }
        return super.dispatchTouchEvent(ev);
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
}

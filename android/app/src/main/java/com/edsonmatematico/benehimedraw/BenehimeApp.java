package com.edsonmatematico.benehimedraw;

import android.app.Application;
import android.os.Build;
import android.util.Log;

import org.lsposed.hiddenapibypass.HiddenApiBypass;

public class BenehimeApp extends Application {
    @Override
    public void onCreate() {
        super.onCreate();
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.P) {
            try {
                HiddenApiBypass.addHiddenApiExemptions("L");
            } catch (Throwable t) {
                Log.w("BenehimeApp", "HiddenApiBypass failed", t);
            }
        }
    }
}

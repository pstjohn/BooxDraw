package com.edsonmatematico.benehimedraw.onyxpen;

import android.os.Build;

public final class DeviceCompat {
    private DeviceCompat() {}

    private static volatile Boolean cached = null;

    public static boolean isOnyxDevice() {
        Boolean v = cached;
        if (v != null) return v;
        synchronized (DeviceCompat.class) {
            if (cached == null) {
                cached = isOnyxManufacturer() && isOnyxSdkAvailable();
            }
            return cached;
        }
    }

    private static boolean isOnyxManufacturer() {
        return "ONYX".equalsIgnoreCase(Build.MANUFACTURER)
                || "ONYX".equalsIgnoreCase(Build.BRAND);
    }

    private static boolean isOnyxSdkAvailable() {
        try {
            Class.forName("com.onyx.android.sdk.pen.TouchHelper");
            return true;
        } catch (ClassNotFoundException e) {
            return false;
        }
    }
}
